import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { IMAGE_DELIVERY_STRATEGIES, type AdapterDef } from "./adapters";
import { TASKS_DIR } from "./config";
import { formatBytes } from "./text";
import { isRecord, typeName } from "./validate";

/** Re-exported: attachment sizes are formatted everywhere attachments are named. */
export { formatBytes };

/**
 * Per-turn attachments (S3, spike ts7efd; widened past images in A1d). The
 * currency is PATHS on disk — codex consumes them directly (`-i <path>… --`),
 * the claude stdin strategy encodes from the file, and everything that is not
 * an image is READ FROM ITS PATH by the harness's own file tools — so the
 * daemon decodes + validates the request body's base64 and stores the bytes
 * under `~/.wisp/tasks/<id>/attachments/turn-<n>/<name>` before the turn
 * spawns. The files belong to exactly the turn whose request carried them: no
 * upload endpoint, no queue, no orphan files (resume turns re-attach
 * nothing — all three harnesses keep the image in session context).
 *
 * Validation never trusts the client: magic bytes decide the type (not the
 * pasted mime), and every rejection is a named 400 — a silently dropped
 * image is droid's failure mode, and wisp's rule is loud, never silent.
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

/**
 * Per-kind size caps. Images stay at droid's hard 5 MB per-file limit (it also
 * tames claude's base64 inflation); documents and text are bounded by what a
 * harness can usefully page through with its own tools; video is the outlier
 * the budget below exists to contain.
 */
export const ATTACHMENT_KIND_LIMITS: Readonly<Record<AttachmentKind, number>> = Object.freeze({
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 20 * 1024 * 1024,
  video: 50 * 1024 * 1024,
});

/** The largest single file any kind allows — the pre-decode base64 guard's ceiling. */
export const MAX_ATTACHMENT_BYTES = ATTACHMENT_KIND_LIMITS.video;
/** Files per turn (a headless turn never needs more; bounds the base64 payload). */
export const MAX_ATTACHMENTS_PER_TURN = 10;
/**
 * The whole turn's raw byte budget, and the load-bearing number of A1d.
 *
 * Before video, the worst case was already 10 × 5 MB = 50 MB, so holding the
 * TOTAL here means the daemon's request ceiling and memory profile do not move
 * when a 50 MB video becomes attachable — and the derived body limit stays
 * under the desktop proxy's 80 MB replayable-body cap, which is the real wall
 * for anything sent through Desktop. The consequence is deliberate and honest:
 * a 50 MB video is the entire turn's budget, not a video plus screenshots.
 */
export const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** base64 inflates by 4/3; the +8 covers padding and the encoder's rounding. */
function base64CharsFor(bytes: number): number {
  return Math.ceil((bytes * 4) / 3) + 8;
}

/** Reject an oversize base64 string before decoding it (the per-file guard). */
export const MAX_BASE64_CHARS = base64CharsFor(MAX_ATTACHMENT_BYTES);
/**
 * The whole payload's base64 ceiling.
 *
 * Exported because the HTTP body ceiling has to be derived from it: a request
 * limit below what this validator still calls valid would answer 413 before
 * any validator could name a reason (a review caught exactly that).
 */
export const MAX_TURN_BASE64_CHARS =
  base64CharsFor(MAX_TURN_ATTACHMENT_BYTES) + 8 * MAX_ATTACHMENTS_PER_TURN;

/** An attachments rejection; the message IS the API's named 400 reason. */
export class AttachError extends Error {
  override name = "AttachError";
}

/**
 * The wire shape the create/send routes accept. Named here because
 * `decodeAttachments` is what validates it — a client that builds this (the web
 * composer, `wisp new --attach`) is building input for that function.
 */
export interface AttachmentPayload {
  name: string;
  dataBase64: string;
}

/** One validated, still-in-memory attachment (the request body decoded). */
export interface DecodedAttachment {
  name: string;
  mediaType: AttachmentMediaType;
  data: Buffer;
}

/** One stored attachment: the turn's file on disk, ready for argv/stdin/path. */
export interface StoredAttachment {
  /** the sanitized on-disk name (what the stream's attach note shows) */
  name: string;
  path: string;
  size: number;
  mediaType: AttachmentMediaType;
}

function hashPart(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
}

/** Stable attachment identity, including names, types, order, and bytes. */
export function taskMessageAttachmentsFingerprint(files: DecodedAttachment[]): string {
  const hash = createHash("sha256");
  hash.update("wisp-task-message-attachments-v1:");
  hashPart(hash, String(files.length));
  for (const file of files) {
    hashPart(hash, file.name);
    hashPart(hash, file.mediaType);
    hashPart(hash, file.data);
  }
  return hash.digest("hex");
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
      if ((b < 0x20 && !TEXT_CONTROL_BYTES.has(b)) || b === 0x7f) return false;
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

/** The one sentence that lists what wisp takes, used by every unsupported-type rejection. */
export const SUPPORTED_ATTACHMENTS =
  "png/jpeg/gif/webp images, pdf, utf-8 text, and mp4/mov/webm video";

/** True when the adapter declares any mechanism for getting an IMAGE to the harness. */
function hasImageCapability(def: AdapterDef): boolean {
  return Boolean(def.image ?? def.imageInput ?? def.imageDelivery);
}

/**
 * Validate + decode a request body's `attachments` field (never trust the
 * client). Returns [] when the field is absent or an empty array. Throws
 * AttachError with the named 400 reason otherwise:
 *   - too many files (> MAX_ATTACHMENTS_PER_TURN)
 *   - per-file: bad shape, invalid base64, empty, oversize for its kind, or
 *     bytes that sniff as nothing wisp stores
 *   - an IMAGE for a harness without image capability (no image/imageInput/
 *     imageDelivery adapter field). Only images: pdf, text and video reach
 *     every harness by path, which is a fact about the prompt rather than a
 *     capability the CLI has to declare.
 *   - a turn whose files exceed MAX_TURN_ATTACHMENT_BYTES together
 */
export function decodeAttachments(harness: string, def: AdapterDef, raw: unknown): DecodedAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AttachError(`attachments must be an array of {name, dataBase64}, got ${typeName(raw)}`);
  }
  if (raw.length === 0) return [];
  // A1c: a delivery harness reads the file with its own tool, and that tool
  // accepts less than wisp's upload set does. Refuse here, by name, rather
  // than hand over a file the harness will choke on mid-turn.
  const accepts = def.imageDelivery ? IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]?.accepts : undefined;
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new AttachError(`at most ${MAX_ATTACHMENTS_PER_TURN} attachments per turn, got ${raw.length}`);
  }
  let total = 0;
  return raw.map((item, i) => {
    const label = `attachments[${i}]`;
    if (!isRecord(item)) throw new AttachError(`${label} must be an object with name and dataBase64, got ${typeName(item)}`);
    if (typeof item.name !== "string" || item.name === "") {
      const got = typeof item.name === "string" ? (item.name === "" ? '""' : "string") : typeName(item.name);
      throw new AttachError(`${label}.name must be a non-empty string, got ${got}`);
    }
    if (typeof item.dataBase64 !== "string") {
      throw new AttachError(`${label} (${item.name}): dataBase64 must be a string, got ${typeName(item.dataBase64)}`);
    }
    const b64 = item.dataBase64;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw new AttachError(`${label} (${item.name}): dataBase64 is not valid base64`);
    }
    if (b64.length > MAX_BASE64_CHARS) {
      throw new AttachError(
        `${label} (${item.name}): over the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit`,
      );
    }
    const data = Buffer.from(b64, "base64");
    if (data.length === 0) throw new AttachError(`${label} (${item.name}): empty file`);
    const mediaType = sniffAttachmentType(data);
    if (!mediaType) {
      throw new AttachError(
        `${label} (${item.name}): not a supported attachment (magic-byte sniff) — wisp takes ${SUPPORTED_ATTACHMENTS}`,
      );
    }
    const kind = attachmentKind(mediaType);
    if (kind === "image") {
      if (!hasImageCapability(def)) {
        throw new AttachError(
          `harness '${harness}' has no image-attachment capability (its adapter declares no image/imageInput/imageDelivery field)`,
        );
      }
      if (accepts && !accepts.includes(mediaType)) {
        const list = accepts.map((t) => t.replace("image/", "")).join(" and ");
        throw new AttachError(
          `${label} (${item.name}): harness '${harness}' reads images from a path with its own file tool, which accepts only ${list} — this is ${mediaType}`,
        );
      }
    }
    const limit = ATTACHMENT_KIND_LIMITS[kind];
    if (data.length > limit) {
      throw new AttachError(
        `${label} (${item.name}): ${formatBytes(data.length)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
      );
    }
    total += data.length;
    if (total > MAX_TURN_ATTACHMENT_BYTES) {
      throw new AttachError(
        `attachments total ${formatBytes(total)}, over the ${formatBytes(MAX_TURN_ATTACHMENT_BYTES)} limit for one turn`,
      );
    }
    return { name: item.name, mediaType, data };
  });
}

/** The name a file falls back to when the client's is empty or dot-only. */
const FALLBACK_NAMES: Readonly<Record<AttachmentKind, string>> = Object.freeze({
  image: "image",
  pdf: "document.pdf",
  text: "text.txt",
  video: "video",
});

/**
 * Strip a client-supplied name down to a safe file name: basename kills any
 * directory traversal, every unsafe character becomes "_", and dot-only or
 * empty results fall back to the kind's own name (extension included where the
 * harness's tools will care which reader to use).
 */
function sanitizeName(raw: string, kind: AttachmentKind): string {
  const cleaned = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned === "" || /^\.+$/.test(cleaned) ? FALLBACK_NAMES[kind] : cleaned;
}

/** "red.png" → "red-2.png"; "noext" → "noext-2" (the extension keeps its dot). */
function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/**
 * Store a turn's decoded attachments under
 * `~/.wisp/tasks/<id>/attachments/turn-<n>/<name>` and return the stored
 * rows. Names are sanitized; a collision (with an existing file or another
 * attachment in the same turn) earns a "-2"/"-3" suffix — no overwrite, ever.
 */
export function writeTurnAttachments(taskId: string, turn: number, files: DecodedAttachment[]): StoredAttachment[] {
  const dir = join(TASKS_DIR, taskId, "attachments", `turn-${turn}`);
  return writeAttachmentsToDir(dir, files);
}

function writeAttachmentsToDir(dir: string, files: DecodedAttachment[]): StoredAttachment[] {
  mkdirSync(dir, { recursive: true });
  const used = new Set(readdirSync(dir).map((name) => name.toLowerCase()));
  return files.map((file) => {
    const base = sanitizeName(file.name, attachmentKind(file.mediaType));
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()) || existsSync(join(dir, name)); n++) {
      name = withSuffix(base, n);
    }
    used.add(name.toLowerCase());
    const path = join(dir, name);
    writeFileSync(path, file.data);
    return { name, path, size: file.data.length, mediaType: file.mediaType };
  });
}

/** Store a submission's bytes before it has a concrete turn number. */
export function writeMessageAttachments(
  taskId: string,
  messageId: string,
  files: DecodedAttachment[],
): StoredAttachment[] {
  return writeAttachmentsToDir(join(attachmentsDirFor(taskId), "messages", messageId), files);
}

export function readMessageAttachments(
  taskId: string,
  messageId: string,
  records: AttachmentRecord[],
): StoredAttachment[] {
  const dir = join(attachmentsDirFor(taskId), "messages", messageId);
  return records.map((record) => ({ ...record, path: join(dir, record.name) }));
}

export function messageAttachmentPath(taskId: string, messageId: string, name: string): string {
  return join(attachmentsDirFor(taskId), "messages", messageId, name);
}

export function removeMessageAttachments(taskId: string, messageId: string): void {
  rmSync(join(attachmentsDirFor(taskId), "messages", messageId), { recursive: true, force: true });
}

/** Move a queued message's files to the stable path of the turn it starts. */
export function promoteMessageAttachments(
  taskId: string,
  messageId: string,
  turn: number,
  records: AttachmentRecord[],
): StoredAttachment[] {
  if (records.length === 0) return [];
  const from = join(attachmentsDirFor(taskId), "messages", messageId);
  const to = join(attachmentsDirFor(taskId), `turn-${turn}`);
  if (existsSync(to)) {
    if (existsSync(from)) {
      throw new Error(`refusing to replace existing attachment directory for turn ${turn}`);
    }
  } else {
    renameSync(from, to);
  }
  return validatePromotedAttachments(to, records);
}

function validatePromotedAttachments(dir: string, records: AttachmentRecord[]): StoredAttachment[] {
  const expected = records.map((record) => record.name).sort();
  const actual = readdirSync(dir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`attachment directory contents do not match the persisted manifest: ${dir}`);
  }
  return records.map((record) => {
    if (basename(record.name) !== record.name) {
      throw new Error(`attachment manifest contains an unsafe name: ${record.name}`);
    }
    const path = join(dir, record.name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size !== record.size) {
      throw new Error(`attachment does not match the persisted manifest: ${path}`);
    }
    const mediaType = sniffStoredAttachment(path);
    if (mediaType !== record.mediaType) {
      throw new Error(`attachment does not match the persisted manifest: ${path}`);
    }
    return { ...record, path };
  });
}

/**
 * The stored file's type, from its leading window rather than the whole file:
 * revalidation runs on the spawn path, and a 50 MB video must not be read end
 * to end to confirm it is still a video.
 */
export function sniffStoredAttachment(path: string): AttachmentMediaType | null {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(SNIFF_WINDOW_BYTES);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    return sniffAttachmentHeader(head.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

/** Undo a promotion when spawning failed before a turn row was created. */
export function restoreMessageAttachments(taskId: string, messageId: string, turn: number): void {
  const from = join(attachmentsDirFor(taskId), `turn-${turn}`);
  const to = join(attachmentsDirFor(taskId), "messages", messageId);
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(join(attachmentsDirFor(taskId), "messages"), { recursive: true });
  renameSync(from, to);
}

/**
 * One attachment as everything outside the daemon knows it (A1a). Deliberately
 * NO path: the file's location is the daemon's business, and a path in a
 * response is a path a client will eventually try to fetch.
 */
export interface AttachmentRecord {
  name: string;
  size: number;
  mediaType: AttachmentMediaType;
}

/**
 * The turn's manifest, for the `turns.attachments_json` column. It is stored on
 * the TURN ROW rather than inferred from the directory for one reason: archive
 * deletes the file bytes (Q4), and a conversation that then forgets a file was
 * ever attached is the silent kind of absence this product refuses. The
 * bytes are unbounded and go; the record is three fields and stays, so the turn
 * can still say "red.png (320 KB), removed when this task was archived".
 *
 * `null` for a turn with no attachments — a column of "[]" rows would claim the
 * feature ran on every turn that predates it.
 */
export function attachmentManifest(files: StoredAttachment[]): string | null {
  if (files.length === 0) return null;
  const records: AttachmentRecord[] = files.map((f) => ({ name: f.name, size: f.size, mediaType: f.mediaType }));
  return JSON.stringify(records);
}

/**
 * Read a turn's manifest back. Never throws: a turn row written by a future
 * version, or hand-edited, must degrade to "this turn has no attachments"
 * rather than break the one route that renders the whole conversation.
 */
export function parseAttachmentManifest(raw: string | null | undefined): AttachmentRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AttachmentRecord =>
        isRecord(r) && typeof r.name === "string" && typeof r.size === "number" && typeof r.mediaType === "string",
    );
  } catch {
    return [];
  }
}

/** `~/.wisp/tasks/<id>/attachments` — the whole task's attachment storage. */
export function attachmentsDirFor(taskId: string): string {
  return join(TASKS_DIR, taskId, "attachments");
}

/**
 * Where a manifest entry's bytes live. The `name` MUST come from the turn's
 * manifest, never from a request: that is what makes traversal a non-question
 * here rather than a check that has to be right (Q1). Names on disk were
 * sanitized by `writeTurnAttachments` before they ever reached the manifest.
 */
export function turnAttachmentPath(taskId: string, turn: number, name: string): string {
  return join(attachmentsDirFor(taskId), `turn-${turn}`, name);
}

/**
 * Drop every file a task ever carried (Q4: on BOTH archive paths, plain and
 * force). Attachments live outside the worktree, so nothing else in archive
 * takes them, and they are the one category of bytes that would otherwise
 * survive an archive and grow without bound. The manifests stay on the turn
 * rows, so the conversation keeps saying what was attached.
 */
export async function removeTaskAttachments(taskId: string): Promise<void> {
  await rm(attachmentsDirFor(taskId), { recursive: true, force: true });
}

/**
 * The one honest line that lands in the turn's log before harness output:
 * `· attached: red.png (320 B), shot2.jpg (1.2 MB)`. A plain-text line (never
 * JSON), so every adapter's parse skips it and the human stream renders it
 * like the `· session …` line.
 */
export function formatAttachNote(files: StoredAttachment[]): string {
  return `· attached: ${files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(", ")}`;
}
