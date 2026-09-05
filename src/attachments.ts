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
import { isRecord, typeName } from "./validate";

/**
 * Per-turn image attachments (S3, spike ts7efd). The currency is PATHS on
 * disk — codex consumes them directly (`-i <path>… --`), the claude stdin
 * strategy encodes from the file — so the daemon decodes + validates the
 * request body's base64 and stores the bytes under
 * `~/.wisp/tasks/<id>/attachments/turn-<n>/<name>` before the turn spawns.
 * The images belong to exactly the turn whose request carried them: no
 * upload endpoint, no queue, no orphan files (resume turns re-attach
 * nothing — all three harnesses keep the image in session context).
 *
 * Validation never trusts the client: magic bytes decide the type (not the
 * pasted mime), and every rejection is a named 400 — a silently dropped
 * image is droid's failure mode, and wisp's rule is loud, never silent.
 */

/** The Anthropic-standard mime set every harness image mechanism accepts (spike-verified). */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** 5MB per file: droid's hard per-file limit, and it tames claude's base64 inflation. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Files per turn (a headless turn never needs more; bounds the base64 payload). */
export const MAX_ATTACHMENTS_PER_TURN = 10;
/** base64 inflates by 4/3 — reject oversize strings before decoding them. */
const MAX_BASE64_CHARS = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8;

/** An attachments rejection; the message IS the API's named 400 reason. */
export class AttachError extends Error {
  override name = "AttachError";
}

/**
 * The wire shape the create/send routes accept. Named here because
 * `decodeAttachments` is what validates it — a client that builds this (the web
 * composer, `wisp new --image`) is building input for that function.
 */
export interface AttachmentPayload {
  name: string;
  dataBase64: string;
}

/** One validated, still-in-memory attachment (the request body decoded). */
export interface DecodedAttachment {
  name: string;
  mediaType: ImageMediaType;
  data: Buffer;
}

/** One stored attachment: the turn's file on disk, ready for argv/stdin. */
export interface StoredAttachment {
  /** the sanitized on-disk name (what the stream's attach note shows) */
  name: string;
  path: string;
  size: number;
  mediaType: ImageMediaType;
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

/** "320 B" / "12 KB" / "1.2 MB" — the attach note's size wording. */
export function formatBytes(n: number): string {
  const trimmed = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trimmed(kb)} KB`;
  return `${trimmed(kb / 1024)} MB`;
}

/**
 * Validate + decode a request body's `attachments` field (never trust the
 * client). Returns [] when the field is absent or an empty array. Throws
 * AttachError with the named 400 reason otherwise:
 *   - harness without image capability (no image/imageInput adapter field)
 *   - too many files (> MAX_ATTACHMENTS_PER_TURN)
 *   - per-file: bad shape, invalid base64, empty, oversize (> 5MB), or bytes
 *     that don't sniff as png/jpeg/gif/webp
 */
export function decodeAttachments(harness: string, def: AdapterDef, raw: unknown): DecodedAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AttachError(`attachments must be an array of {name, dataBase64}, got ${typeName(raw)}`);
  }
  if (raw.length === 0) return [];
  if (!def.image && !def.imageInput && !def.imageDelivery) {
    throw new AttachError(
      `harness '${harness}' has no image-attachment capability (its adapter declares no image/imageInput/imageDelivery field)`,
    );
  }
  // A1c: a delivery harness reads the file with its own tool, and that tool
  // accepts less than wisp's upload set does. Refuse here, by name, rather
  // than hand over a file the harness will choke on mid-turn.
  const accepts = def.imageDelivery ? IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]?.accepts : undefined;
  if (raw.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new AttachError(`at most ${MAX_ATTACHMENTS_PER_TURN} attachments per turn, got ${raw.length}`);
  }
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
      throw new AttachError(`${label} (${item.name}): over the 5 MB per-file limit`);
    }
    const data = Buffer.from(b64, "base64");
    if (data.length === 0) throw new AttachError(`${label} (${item.name}): empty file`);
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachError(`${label} (${item.name}): ${formatBytes(data.length)} exceeds the 5 MB per-file limit`);
    }
    const mediaType = sniffImageType(data);
    if (!mediaType) {
      throw new AttachError(`${label} (${item.name}): not a png/jpeg/gif/webp image (magic-byte sniff)`);
    }
    if (accepts && !accepts.includes(mediaType)) {
      const list = accepts.map((t) => t.replace("image/", "")).join(" and ");
      throw new AttachError(
        `${label} (${item.name}): harness '${harness}' reads images from a path with its own file tool, which accepts only ${list} — this is ${mediaType}`,
      );
    }
    return { name: item.name, mediaType, data };
  });
}

/**
 * Strip a client-supplied name down to a safe file name: basename kills any
 * directory traversal, every unsafe character becomes "_", and dot-only or
 * empty results fall back to "image".
 */
function sanitizeName(raw: string): string {
  const cleaned = basename(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned === "" || /^\.+$/.test(cleaned) ? "image" : cleaned;
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
    const base = sanitizeName(file.name);
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

/** Move a queued message's images to the stable path of the turn it starts. */
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
    const mediaType = sniffStoredImage(path);
    if (mediaType !== record.mediaType) {
      throw new Error(`attachment does not match the persisted manifest: ${path}`);
    }
    return { ...record, path };
  });
}

function sniffStoredImage(path: string): ImageMediaType | null {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(12);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    return sniffImageType(head.subarray(0, bytesRead));
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
  mediaType: ImageMediaType;
}

/**
 * The turn's manifest, for the `turns.attachments_json` column. It is stored on
 * the TURN ROW rather than inferred from the directory for one reason: archive
 * deletes the image bytes (Q4), and a conversation that then forgets an image
 * was ever attached is the silent kind of absence this product refuses. The
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

/** `~/.wisp/tasks/<id>/attachments` — the whole task's image storage. */
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
 * Drop every image a task ever carried (Q4: on BOTH archive paths, plain and
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
