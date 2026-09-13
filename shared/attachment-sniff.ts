/**
 * Attachment type sniffing shared by daemon and browser. Everything here is
 * pure byte inspection: no paths, no registry, no I/O, and no runtime-specific
 * APIs.
 *
 * Validation never trusts the client: magic bytes decide the type (not the
 * pasted mime), and text is the only rule that can accept bytes no signature
 * claims, so it runs LAST and as a scan rather than a prefix test.
 */

/** The Anthropic-standard mime set every harness image mechanism accepts (spike-verified). */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** Documents wisp stores for path delivery: a pdf, or anything that is honestly utf-8 text. */
export type DocumentMediaType = "application/pdf" | "text/plain";
/** Container formats a person actually pastes: mp4/m4v, quicktime, webm. */
export type VideoMediaType = "video/mp4" | "video/quicktime" | "video/webm";
export type AttachmentMediaType = ImageMediaType | DocumentMediaType | VideoMediaType;

/**
 * What a stored attachment IS, as the rest of wisp reasons about it: the caps,
 * the delivery mechanism, and the composer's rendering all key off this rather
 * than off a mime-string prefix test written four times.
 */
export type AttachmentKind = "image" | "pdf" | "text" | "video";

export function attachmentKind(mediaType: string): AttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  return mediaType === "application/pdf" ? "pdf" : "text";
}

/** Sniff the magic bytes; the pasted filename/mime is never trusted. */
export function sniffImageType(data: Uint8Array): ImageMediaType | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png"; // ‰PNG…
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return "image/gif"; // GIF87a / GIF89a
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 && // RIFF….WEBP
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < data.length; i++) out += String.fromCharCode(data[i]!);
  return out;
}

/** `%PDF-` at byte 0. A pdf that hides its header behind junk is not one wisp stores. */
function sniffPdf(data: Uint8Array): DocumentMediaType | null {
  return data.length >= 5 && ascii(data, 0, 5) === "%PDF-" ? "application/pdf" : null;
}

/**
 * The ISO-BMFF brands that actually mean VIDEO.
 *
 * An allowlist rather than "anything with an ftyp box", because the container
 * is not the format: HEIC and AVIF photos, and M4A audio, are ISO-BMFF too. A
 * `qt  ` brand is QuickTime; the rest are the mp4 family, and a `<video>`
 * element wants to be told which it got. Trailing spaces are trimmed first —
 * the brand field is four bytes, so `M4V ` is how "M4V" is spelled.
 *
 * A video whose brand is not here is refused by name (it falls through to the
 * text scan and fails), which is the safe direction: storing a photo as a
 * video would tell the model to run ffmpeg on a still.
 */
const MP4_BRANDS = new Set([
  "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71", "mmp4",
  "avc1", "dash", "M4V", "M4VH", "M4VP", "3gp4", "3gp5", "3g2a",
]);

/** ISO-BMFF (`….ftyp<brand>`) and Matroska/WebM (EBML magic). */
function sniffVideo(data: Uint8Array): VideoMediaType | null {
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return "video/webm"; // EBML — matroska or webm; the browser reads both as webm
  }
  if (data.length >= 12 && ascii(data, 4, 4) === "ftyp") {
    const brand = ascii(data, 8, 4).replace(/ +$/, "");
    if (brand === "qt") return "video/quicktime";
    return MP4_BRANDS.has(brand) ? "video/mp4" : null;
  }
  return null;
}

/** The control bytes real text files carry: tab, newline, form feed, CR, and ESC (ANSI logs). */
const TEXT_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

/** The one byte-level text refusal a streaming validator can apply per chunk. */
export function hasNonTextByte(b: number): boolean {
  return (b < 0x20 && !TEXT_CONTROL_BYTES.has(b)) || b === 0x7f;
}

/**
 * "Is this honestly utf-8 text?" — wisp's only sniff without magic bytes, so
 * it is a scan rather than a prefix test: no NUL, no stray control bytes, and
 * every multi-byte sequence well-formed (no overlongs, no surrogates, nothing
 * past U+10FFFF).
 *
 * `truncated` is what makes the same rule usable on a 4 KiB window: a window
 * ending mid-character must not be called binary, so an incomplete sequence at
 * the very end passes there and fails on a whole file. That direction matters —
 * the upload path scans the WHOLE buffer, and promotion re-checks only the
 * window, so anything that got in must still pass on the way through.
 */
export function looksLikeUtf8Text(data: Uint8Array, truncated = false): boolean {
  let i = 0;
  while (i < data.length) {
    const b = data[i]!;
    if (b < 0x80) {
      if (hasNonTextByte(b)) return false;
      i += 1;
      continue;
    }
    const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 0;
    if (length === 0 || b > 0xf4) return false; // continuation byte, overlong lead, or out of range
    if (i + length > data.length) return truncated;
    const second = data[i + 1]!;
    if ((second & 0xc0) !== 0x80) return false;
    if (b === 0xe0 && second < 0xa0) return false; // overlong 3-byte
    if (b === 0xed && second > 0x9f) return false; // utf-16 surrogate half
    if (b === 0xf0 && second < 0x90) return false; // overlong 4-byte
    if (b === 0xf4 && second > 0x8f) return false; // past U+10FFFF
    for (let k = 2; k < length; k++) {
      if ((data[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += length;
  }
  return true;
}

/** How much of a stored file the header sniff reads back (promotion revalidation). */
export const SNIFF_WINDOW_BYTES = 4096;

/**
 * The whole-buffer sniff, in the order the formats can be told apart: magic
 * bytes first, utf-8 text last (it is the only rule that can accept bytes no
 * signature claims). Text is scanned in full here — the strict end of the
 * pair `looksLikeUtf8Text` documents.
 */
export function sniffAttachmentType(data: Uint8Array): AttachmentMediaType | null {
  return (
    sniffImageType(data) ??
    sniffPdf(data) ??
    sniffVideo(data) ??
    (data.length > 0 && looksLikeUtf8Text(data) ? "text/plain" : null)
  );
}

/** The same sniff against a leading window, tolerant of a character split by its edge. */
export function sniffAttachmentHeader(head: Uint8Array): AttachmentMediaType | null {
  return (
    sniffImageType(head) ??
    sniffPdf(head) ??
    sniffVideo(head) ??
    (head.length > 0 && looksLikeUtf8Text(head, true) ? "text/plain" : null)
  );
}
