import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";

/**
 * The client half of S3 attachments. The daemon's src/attachments.ts is the
 * AUTHORITY — it re-sniffs magic bytes and re-checks every cap on the wire;
 * these mirrors exist so a bad paste fails quietly-inline instead of
 * round-tripping. The two files share caps and wording by hand (the classic
 * UI's key-sharing contract, one level up).
 *
 * Paste-only this slice (drag-drop chrome is NOT scope). Pending rows render
 * as muted text (`name.png · 12 KB · ✕`) — no chip, no badge, no tint
 * (design law); the small thumbnail is content, not status.
 *
 * A1d widened this past images: pdf, text and video are attachments too, and a
 * paste longer than PASTE_TO_FILE_CHARS becomes a text file rather than
 * composer content.
 */

/** Mirrors of src/attachments.ts — the daemon re-validates regardless. */
export const ATTACHMENT_KIND_LIMITS = {
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 20 * 1024 * 1024,
  video: 50 * 1024 * 1024,
} as const;
export const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** What the file input offers the platform. A hint, never a check. */
export const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,video/mp4,video/quicktime,video/webm,text/*,.csv,.log,.json,.md,.txt,.tsv,.yaml,.yml";

export type AttachmentKind = keyof typeof ATTACHMENT_KIND_LIMITS;

export function attachmentKind(mediaType: string): AttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  return mediaType === "application/pdf" ? "pdf" : "text";
}

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  kind: AttachmentKind;
  /**
   * The picked/pasted file itself, encoded to base64 only when the composer
   * submits. A 50 MB video encodes to a 67 MB string, and holding that in
   * composer state from the moment of the paste — for a file the user may
   * still remove — is the one thing this feature could do to a phone.
   */
  file: File;
  bytes: number;
  /** object URL for the image thumbnail; "" for other kinds and where createObjectURL is absent (jsdom) */
  url: string;
}

/**
 * The one place a stored attachment's URL is built (A1a). It is a daemon API
 * PATH, not a loadable URL: the read is authenticated like every other one, so
 * the browser fetches it with its bearer header and renders the bytes from a
 * blob URL (`useAssetSrc`). The name is percent-encoded because it is a path
 * segment on the wire — the daemon still resolves it against the turn's
 * manifest rather than against the filesystem, so this encoding is transport
 * correctness, not a security boundary.
 */
export function attachmentUrl(taskId: string, turn: number, name: string): string {
  return `/api/tasks/${taskId}/attachments/${turn}/${encodeURIComponent(name)}`;
}

export function messageAttachmentUrl(taskId: string, messageId: string, name: string): string {
  return `/api/tasks/${taskId}/messages/${messageId}/attachments/${encodeURIComponent(name)}`
}

/** POST /api/tasks and /send accept attachments as { name, dataBase64 }. */
export interface AttachmentPayload {
  name: string;
  dataBase64: string;
}

export async function attachmentPayloads(list: PendingAttachment[]): Promise<AttachmentPayload[]> {
  return await Promise.all(
    list.map(async (a) => ({ name: a.name, dataBase64: base64Encode(new Uint8Array(await a.file.arrayBuffer())) })),
  );
}

/**
 * The disabled-with-reason note for an IMAGE pasted at a harness without
 * capability. No harness is named here: all five builtins CAN take an image
 * (A1c gave droid prompt-path delivery), so the only defs left without a
 * mechanism are ones the user wrote, and the honest sentence names theirs.
 *
 * Only images can hit this. pdf, text and video reach every harness by path
 * (A1d), which is a fact about the prompt rather than a capability a CLI has
 * to declare.
 */
export function noImageReason(harness: string): string {
  return `harness '${harness}' has no image-attachment capability`;
}

/** src/attachments.ts's sniffer, mirrored: png/jpeg/gif/webp by magic bytes, never the pasted mime. */
export function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && // RIFF….WEBP
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}

/** The control bytes real text files carry: tab, newline, form feed, CR, and ESC. */
const TEXT_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

/** src/attachments.ts's utf-8 scan, mirrored: no NUL, no stray controls, no malformed sequences. */
export function looksLikeUtf8Text(b: Uint8Array): boolean {
  let i = 0;
  while (i < b.length) {
    const byte = b[i]!;
    if (byte < 0x80) {
      if ((byte < 0x20 && !TEXT_CONTROL_BYTES.has(byte)) || byte === 0x7f) return false;
      i += 1;
      continue;
    }
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 ? 2 : 0;
    if (length === 0 || byte > 0xf4 || i + length > b.length) return false;
    const second = b[i + 1]!;
    if ((second & 0xc0) !== 0x80) return false;
    if (byte === 0xe0 && second < 0xa0) return false;
    if (byte === 0xed && second > 0x9f) return false;
    if (byte === 0xf0 && second < 0x90) return false;
    if (byte === 0xf4 && second > 0x8f) return false;
    for (let k = 2; k < length; k++) if ((b[i + k]! & 0xc0) !== 0x80) return false;
    i += length;
  }
  return true;
}

/** src/attachments.ts's whole-buffer sniff, mirrored: magic bytes first, utf-8 text last. */
export function sniffAttachmentType(b: Uint8Array): string | null {
  const image = sniffImageType(b);
  if (image) return image;
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    return ascii(b, 8, 4) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return b.length > 0 && looksLikeUtf8Text(b) ? "text/plain" : null;
}

/** src/attachments.ts's formatBytes, mirrored: "320 B" / "12 KB" / "1.2 MB". */
export function formatBytes(n: number): string {
  const trimmed = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trimmed(kb)} KB`;
  return `${trimmed(kb / 1024)} MB`;
}

/** base64 without the spread-stack blowup (50MB of bytes never hits one apply). */
function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * The length past which a pasted wall of text becomes a FILE instead of
 * composer content (A1d).
 *
 * Roughly 2k tokens. Below it, a stack trace or a long prompt belongs in the
 * message, where the model reads it in one go. Above it — the csv someone
 * selected out of a spreadsheet — a file is strictly better: the agent greps
 * and slices it with its own tools instead of paying for the whole thing in
 * one context window, and the composer stays readable.
 *
 * The threshold is never silent: the composer says what it did and offers to
 * put the text back inline.
 */
export const PASTE_TO_FILE_CHARS = 8000;

/** A csv keeps its extension: the agent's next move depends on knowing it is one. */
function pastedTextExtension(text: string): string {
  const lines = text.split("\n", 5).filter((line) => line.trim() !== "");
  if (lines.length < 2) return "txt";
  for (const delimiter of [",", "\t"]) {
    const counts = lines.map((line) => line.split(delimiter).length - 1);
    if (counts[0]! >= 1 && counts.every((n) => n === counts[0])) return delimiter === "," ? "csv" : "tsv";
  }
  return "txt";
}

/** The file a long paste becomes. `n` numbers it within the composer's list. */
export function pastedTextFile(text: string, n: number): File {
  return new File([text], `pasted-${n}.${pastedTextExtension(text)}`, { type: "text/plain" });
}

/**
 * Read one pasted file into a pending attachment, or name the client-side
 * rejection (type / empty / oversize). The count and budget caps live in the
 * hook — it owns the running list.
 */
export async function readAttachment(
  file: File,
): Promise<{ ok: true; attachment: Omit<PendingAttachment, "id" | "url"> } | { ok: false; reason: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // A clipboard file often arrives nameless (a screenshot), so the fallback is
  // built from what the bytes turn out to BE rather than assumed to be an image.
  const unnamed = (kind: string) => `pasted ${kind}`;
  if (bytes.byteLength === 0) return { ok: false, reason: `${file.name || unnamed("file")}: empty file` };
  const mediaType = sniffAttachmentType(bytes);
  if (!mediaType) {
    return {
      ok: false,
      reason: `${file.name || unnamed("file")}: not an image, pdf, text file, or mp4/mov/webm video`,
    };
  }
  const kind = attachmentKind(mediaType);
  const name = file.name || unnamed(kind);
  const limit = ATTACHMENT_KIND_LIMITS[kind];
  if (bytes.byteLength > limit) {
    return {
      ok: false,
      reason: `${name}: ${formatBytes(bytes.byteLength)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
    };
  }
  return { ok: true, attachment: { name, mediaType, kind, file, bytes: bytes.byteLength } };
}

/**
 * Put a paste-turned-file back where it was typed. The caret is clamped
 * because the value has been editable since the paste, and an index past the
 * end would silently append instead of landing where the user is looking.
 */
export function insertPastedText(value: string, pasted: PastedText): string {
  const at = Math.min(Math.max(pasted.caret, 0), value.length);
  return value.slice(0, at) + pasted.text + value.slice(at);
}

/** Drop the row a long paste became, once its text is back in the composer (A1d). */
export function undoPastedFile(attachments: PendingAttachments, name: string): void {
  const row = attachments.list.find((a) => a.name === name);
  if (row) attachments.remove(row.id);
}

/** A paste the composer turned into a file, and everything undoing it needs. */
export interface PastedText {
  name: string;
  text: string;
  /** where the caret was when it was pasted, so putting it back lands where it was typed */
  caret: number;
}

export interface PendingAttachments {
  list: PendingAttachment[];
  /** the muted client-side note (capability / caps / type) — null when quiet */
  note: string | null;
  /**
   * Wire payloads for the submit body; undefined = omit the field entirely.
   * Async because the bytes are encoded HERE rather than at paste time (A1d).
   */
  payloads: () => Promise<AttachmentPayload[] | undefined>;
  /**
   * File half of composer paste. Text is left to handleComposerPaste — this
   * only preventDefaults when there are files.
   */
  onPaste: (e: ClipboardEvent) => void;
  /**
   * Attach files chosen from the machine (A1a: "pick images from my folder").
   * The same read/validate/note path as a paste — a picked file and a pasted
   * file must not be able to disagree about what is acceptable.
   */
  addFiles: (files: File[]) => void;
  /**
   * Attach a long paste as a text file (A1d). Separate from addFiles because
   * a paste that leaves the textarea has to be undoable.
   */
  addPastedText: (text: string, caret: number) => void;
  /**
   * The most recent paste-turned-file, for the composer's "insert it inline
   * instead" line. Cleared when that row goes, by either route.
   */
  pastedText: PastedText | null;
  /**
   * The harness's delivery caveat, shown while images are pending (A1c). Not a
   * rejection: the attach worked, and this is the part of "worked" the user
   * cannot see from the rows alone.
   */
  deliveryNote: string | null;
  remove: (id: string) => void;
  /** clears rows + note; the composers call it ONLY after a successful submit */
  clear: () => void;
}

interface RememberedAttachments {
  list: PendingAttachment[];
  note: string | null;
  seq: number;
}

const rememberedAttachments = new Map<string, RememberedAttachments>();

interface PendingAttachmentRead {
  cancelled: boolean;
}

/**
 * Reads are registered before their first await so connection removal/reset
 * can revoke their authority even when no remembered row exists yet.
 */
const pendingRememberedReads = new Map<string, Set<PendingAttachmentRead>>();

function unregisterRememberedRead(rememberKey: string, read: PendingAttachmentRead): void {
  const reads = pendingRememberedReads.get(rememberKey);
  if (!reads) return;
  reads.delete(read);
  if (reads.size === 0) pendingRememberedReads.delete(rememberKey);
}

function cancelReads(reads: Iterable<PendingAttachmentRead>): void {
  for (const read of reads) read.cancelled = true;
}

/** Revoke and forget all pending bytes owned by one removed connection. */
export function clearRememberedAttachments(connectionId: string): void {
  const prefix = `${connectionId}\u0000`;
  for (const [rememberKey, reads] of pendingRememberedReads) {
    if (!rememberKey.startsWith(prefix)) continue;
    cancelReads(reads);
    pendingRememberedReads.delete(rememberKey);
  }
  for (const [rememberKey, value] of rememberedAttachments) {
    if (!rememberKey.startsWith(prefix)) continue;
    for (const attachment of value.list) {
      if (attachment.url) URL.revokeObjectURL(attachment.url);
    }
    rememberedAttachments.delete(rememberKey);
  }
}

/**
 * Pending-attachment state for one composer (create dialog / steer box).
 * `hasImage` is tri-state: true/false = known IMAGE capability (a false one
 * refuses pasted images by name and takes the other kinds anyway),
 * undefined = the harness list hasn't landed yet — allow optimistically; the
 * daemon re-validates and its named 400 renders inline.
 */
export function usePendingAttachments({
  harness,
  hasImage,
  imageNote,
  rememberKey,
}: {
  harness: string | null;
  hasImage: boolean | undefined;
  /**
   * The harness's own caveat about HOW its images travel (A1c: droid reads them
   * from a path, which is png/jpeg-only and depends on the model). Written by
   * the adapter, carried by /api/harnesses, shown here — the composer never
   * composes this sentence itself.
   */
  imageNote?: string;
  /** Desktop-only in-memory scope. Omitted by the browser and create dialog. */
  rememberKey?: string;
}): PendingAttachments {
  const remembered = rememberKey ? rememberedAttachments.get(rememberKey) : undefined;
  const [list, setList] = useState<PendingAttachment[]>(remembered?.list ?? []);
  const [note, setNote] = useState<string | null>(remembered?.note ?? null);
  const [pastedText, setPastedText] = useState<PastedText | null>(null);
  const seq = useRef(remembered?.seq ?? 0);
  /** Numbers `pasted-1.csv`; separate from `seq` so the name is known before the read finishes. */
  const pasteSeq = useRef(0);
  const noteRef = useRef(note);
  const pendingReads = useRef(new Set<PendingAttachmentRead>());
  // the async paste loop reads the live list through this mirror, so the
  // setters stay pure (no URL revocation inside a state updater)
  const listRef = useRef<PendingAttachment[]>(remembered?.list ?? []);
  const persist = (nextList: PendingAttachment[], nextNote = noteRef.current) => {
    if (rememberKey) {
      rememberedAttachments.set(rememberKey, {
        list: nextList,
        note: nextNote,
        seq: seq.current,
      });
    }
  };
  const commit = (next: PendingAttachment[]) => {
    listRef.current = next;
    persist(next);
    setList(next);
  };
  const commitNote = (next: string | null) => {
    noteRef.current = next;
    persist(listRef.current, next);
    setNote(next);
  };

  const remove = (id: string) => {
    const hit = listRef.current.find((a) => a.id === id);
    if (hit?.url) URL.revokeObjectURL(hit.url);
    setPastedText((current) => (current && hit && current.name === hit.name ? null : current));
    commit(listRef.current.filter((a) => a.id !== id));
  };

  const cancelPendingReads = () => {
    cancelReads(pendingReads.current);
    if (rememberKey) {
      for (const read of pendingReads.current) unregisterRememberedRead(rememberKey, read);
    }
    pendingReads.current.clear();
  };

  const clear = () => {
    setPastedText(null);
    cancelPendingReads();
    for (const a of listRef.current) if (a.url) URL.revokeObjectURL(a.url);
    commit([]);
    commitNote(null);
    if (rememberKey) rememberedAttachments.delete(rememberKey);
  };

  // A completed remembered row survives navigation, but a read that has not
  // completed must not create an orphaned URL or write state after unmount.
  useEffect(() => {
    const reads = pendingReads.current;
    const key = rememberKey;
    return () => {
      cancelReads(reads);
      if (key) {
        for (const read of reads) unregisterRememberedRead(key, read);
      }
      reads.clear();
    };
  }, [rememberKey]);

  /** One path for both pasting and picking: the two must never disagree. */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const pendingRead: PendingAttachmentRead = { cancelled: false };
    pendingReads.current.add(pendingRead);
    if (rememberKey) {
      const reads = pendingRememberedReads.get(rememberKey) ?? new Set<PendingAttachmentRead>();
      reads.add(pendingRead);
      pendingRememberedReads.set(rememberKey, reads);
    }
    void (async () => {
      try {
        let rejection: string | null = null;
        for (const file of files) {
          if (pendingRead.cancelled) return;
          if (listRef.current.length >= MAX_ATTACHMENTS) {
            rejection = `at most ${MAX_ATTACHMENTS} attachments per turn`;
            break;
          }
          const result = await readAttachment(file);
          if (pendingRead.cancelled) return;
          if (!result.ok) {
            rejection = result.reason;
            continue;
          }
          // Only IMAGES need a harness mechanism; a pdf, a text file or a video
          // reaches every harness by path (A1d), so the capability check is
          // per file rather than a gate on the whole composer.
          if (result.attachment.kind === "image" && harness && hasImage === false) {
            rejection = noImageReason(harness);
            continue;
          }
          const total = listRef.current.reduce((n, a) => n + a.bytes, 0) + result.attachment.bytes;
          if (total > MAX_TURN_ATTACHMENT_BYTES) {
            rejection = `${result.attachment.name}: over the ${formatBytes(MAX_TURN_ATTACHMENT_BYTES)} limit for one turn`;
            continue;
          }
          seq.current += 1;
          // the thumbnail is the only reason to hold a blob URL, so only images get one
          const url =
            result.attachment.kind === "image" && typeof URL.createObjectURL === "function"
              ? URL.createObjectURL(file)
              : "";
          commit([...listRef.current, { id: `att-${seq.current}`, url, ...result.attachment }]);
        }
        // a fully-clean batch clears the previous note; the latest rejection wins otherwise
        if (!pendingRead.cancelled) commitNote(rejection);
      } finally {
        pendingReads.current.delete(pendingRead);
        if (rememberKey) unregisterRememberedRead(rememberKey, pendingRead);
      }
    })();
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // a text paste passes through untouched
    e.preventDefault(); // a file paste never inserts junk text
    addFiles(files);
  };

  /**
   * A wall of pasted text, as a file (A1d). The record is what makes the
   * threshold safe to have: the composer says which file the paste became and
   * offers to put it back inline. A paste that silently vanished from the
   * textarea would be the same quiet lie as a dropped image.
   */
  const addPastedText = (text: string, caret: number): void => {
    const file = pastedTextFile(text, pasteSeq.current + 1);
    pasteSeq.current += 1;
    setPastedText({ name: file.name, text, caret });
    addFiles([file]);
  };

  return {
    list,
    note,
    payloads: async () => (list.length > 0 ? await attachmentPayloads(list) : undefined),
    onPaste,
    addFiles,
    addPastedText,
    pastedText,
    // shown only once there is an image to caveat: the note is about how
    // IMAGES travel, and a pdf beside it would make it read as a lie
    deliveryNote: list.some((a) => a.kind === "image") ? (imageNote ?? null) : null,
    remove,
    clear,
  };
}
