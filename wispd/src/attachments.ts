import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  createReadStream,
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
import {
  AttachmentUploadError,
  claimAttachmentUpload,
  consumeAttachmentUpload,
  releaseAttachmentUpload,
  type StagedAttachment,
} from "./attachment-uploads";
import {
  attachmentKind,
  sniffAttachmentHeader,
  sniffAttachmentType,
  SNIFF_WINDOW_BYTES,
  type AttachmentKind,
  type AttachmentMediaType,
} from "../../shared/attachment-sniff";
import { TASKS_DIR } from "./config";
import { formatBytes } from "./text";
import { isRecord, typeName } from "./validate";

/** Re-exported: attachment sizes are formatted everywhere attachments are named. */
export { formatBytes };
export {
  attachmentKind,
  looksLikeUtf8Text,
  sniffAttachmentHeader,
  sniffAttachmentType,
  sniffImageType,
  SNIFF_WINDOW_BYTES,
  type AttachmentKind,
  type AttachmentMediaType,
  type DocumentMediaType,
  type ImageMediaType,
  type VideoMediaType,
} from "../../shared/attachment-sniff";

/**
 * Per-turn attachments (S3, spike ts7efd; widened past images in A1d). The
 * currency is PATHS on disk — codex consumes them directly (`-i <path>… --`),
 * the claude stdin strategy encodes from the file, and everything that is not
 * an image is READ FROM ITS PATH by the harness's own file tools — so the
 * daemon validates either a one-shot staged upload or the legacy base64 body,
 * then stores the bytes under
 * `~/.wisp/tasks/<id>/attachments/turn-<n>/<name>` before the turn spawns.
 * Resume turns re-attach nothing: all harnesses keep the file in session
 * context.
 *
 * Validation never trusts the client: magic bytes decide the type (not the
 * pasted mime), and every rejection is a named 400 — a silently dropped
 * image is droid's failure mode, and wisp's rule is loud, never silent.
 */

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
 * TOTAL here means neither daemon memory nor temporary disk use grows with a
 * mixed batch. The consequence is deliberate and honest: a 50 MB video is the
 * entire turn's budget, not a video plus screenshots.
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

  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The wire shape the create/send routes accept. Named here because
 * `decodeAttachments` is what validates it — a client that builds this (the web
 * composer, `wisp new --attach`) is building input for that function.
 */
export interface InlineAttachmentPayload {
  name: string;
  dataBase64: string;
}

export interface StagedAttachmentPayload {
  name: string;
  uploadId: string;
}

export type AttachmentPayload = InlineAttachmentPayload | StagedAttachmentPayload;

/** One validated legacy attachment whose request body was decoded in memory. */
export interface InlineDecodedAttachment {
  name: string;
  mediaType: AttachmentMediaType;
  data: Buffer;
  size?: number;
  contentHash?: string;
}

/** One validated staged attachment. Its bytes stay on disk throughout submission. */
export type StagedDecodedAttachment = StagedAttachment;

export type DecodedAttachment = InlineDecodedAttachment | StagedDecodedAttachment;

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

/** Stable legacy attachment identity, including names, types, order, and bytes. */
export function taskMessageAttachmentsFingerprint(files: DecodedAttachment[]): string {
  const hash = createHash("sha256");
  hash.update("wisp-task-message-attachments-v1:");
  hashPart(hash, String(files.length));
  for (const file of files) {
    if ("uploadId" in file) {
      throw new Error("staged attachments require the asynchronous fingerprint");
    }
    hashPart(hash, file.name);
    hashPart(hash, file.mediaType);
    hashPart(hash, file.data);
  }
  return hash.digest("hex");
}

/** New submissions hash the upload-time digest, avoiding a second full disk read. */
export function taskMessageAttachmentsFingerprintV2(files: DecodedAttachment[]): string {
  const hash = createHash("sha256");
  hash.update("wisp-task-message-attachments-v2:");
  hashPart(hash, String(files.length));
  for (const file of files) {
    hashPart(hash, file.name);
    hashPart(hash, file.mediaType);
    hashPart(
      hash,
      "uploadId" in file
        ? file.contentHash
        : file.contentHash ?? createHash("sha256").update(file.data).digest("hex"),
    );
  }
  return hash.digest("hex");
}

/**
 * The persisted v1 fingerprint, streamed for staged files so retries remain
 * compatible with messages written by older daemons without loading the file.
 */
export async function taskMessageAttachmentsFingerprintForSubmission(
  files: DecodedAttachment[],
): Promise<string> {
  if (files.every((file) => !("uploadId" in file))) {
    return taskMessageAttachmentsFingerprint(files);
  }
  const hash = createHash("sha256");
  hash.update("wisp-task-message-attachments-v1:");
  hashPart(hash, String(files.length));
  for (const file of files) {
    hashPart(hash, file.name);
    hashPart(hash, file.mediaType);
    if (!("uploadId" in file)) {
      hashPart(hash, file.data);
      continue;
    }
    hash.update(String(file.size));
    hash.update(":");
    let bytes = 0;
    for await (const chunk of createReadStream(file.path)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== file.size) {
      throw new Error(`attachment upload '${file.uploadId}' changed while being submitted`);
    }
  }
  return hash.digest("hex");
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
  const claimed: DecodedAttachment[] = [];
  let total = 0;
  try {
    return raw.map((item, i) => {
      const label = `attachments[${i}]`;
      if (!isRecord(item)) {
        throw new AttachError(`${label} must be an object with name and dataBase64, got ${typeName(item)}`);
      }
      if (typeof item.name !== "string" || item.name === "") {
        const got = typeof item.name === "string" ? (item.name === "" ? '""' : "string") : typeName(item.name);
        throw new AttachError(`${label}.name must be a non-empty string, got ${got}`);
      }
      let file: DecodedAttachment;
      if (typeof item.uploadId === "string" && item.dataBase64 === undefined) {
        try {
          file = claimAttachmentUpload(item.uploadId, item.name);
        } catch (error) {
          throw new AttachError(
            error instanceof Error ? error.message : String(error),
            error instanceof AttachmentUploadError ? error.status : 400,
          );
        }
      } else {
        if (item.uploadId !== undefined) {
          throw new AttachError(`${label} (${item.name}): provide uploadId or dataBase64, not both`);
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
        file = {
          name: item.name,
          mediaType,
          data,
          size: data.length,
          contentHash: createHash("sha256").update(data).digest("hex"),
        };
      }
      claimed.push(file);
      const kind = attachmentKind(file.mediaType);
      if (kind === "image" && !hasImageCapability(def)) {
        throw new AttachError(
          `harness '${harness}' has no image-attachment capability (its adapter declares no image/imageInput/imageDelivery field)`,
        );
      }
      if (kind === "image" && accepts && !accepts.includes(file.mediaType)) {
        const list = accepts.map((t) => t.replace("image/", "")).join(" and ");
        throw new AttachError(
          `${label} (${item.name}): harness '${harness}' reads images from a path with its own file tool, which accepts only ${list} — this is ${file.mediaType}`,
        );
      }
      const size = "uploadId" in file ? file.size : file.data.length;
      const limit = ATTACHMENT_KIND_LIMITS[kind];
      if (size > limit) {
        throw new AttachError(
          `${label} (${item.name}): ${formatBytes(size)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
        );
      }
      total += size;
      if (total > MAX_TURN_ATTACHMENT_BYTES) {
        throw new AttachError(
          `attachments total ${formatBytes(total)}, over the ${formatBytes(MAX_TURN_ATTACHMENT_BYTES)} limit for one turn`,
        );
      }
      return file;
    });
  } catch (error) {
    releaseDecodedAttachments(claimed);
    throw error;
  }
}

/** Release one-shot uploads that validation or submission did not consume. */
export function releaseDecodedAttachments(files: DecodedAttachment[]): void {
  for (const file of files) {
    if ("uploadId" in file) releaseAttachmentUpload(file.uploadId);
  }
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
  const stored: StoredAttachment[] = [];
  try {
    for (const file of files) {
      const base = sanitizeName(file.name, attachmentKind(file.mediaType));
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()) || existsSync(join(dir, name)); n++) {
        name = withSuffix(base, n);
      }
      used.add(name.toLowerCase());
      const path = join(dir, name);
      if ("uploadId" in file) {
        consumeAttachmentUpload(file.uploadId, path);
      } else {
        writeFileSync(path, file.data, { mode: 0o600 });
      }
      stored.push({
        name,
        path,
        size: "uploadId" in file ? file.size : file.data.length,
        mediaType: file.mediaType,
      });
    }
    return stored;
  } catch (error) {
    for (const file of stored) rmSync(file.path, { force: true });
    throw error;
  }
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
