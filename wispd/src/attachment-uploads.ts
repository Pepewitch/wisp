import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import {
  hasNonTextByte,
  sniffAttachmentHeader,
  type AttachmentMediaType,
  SNIFF_WINDOW_BYTES,
} from "../../shared/attachment-sniff";
import { UPLOADS_DIR } from "./config";

/** Unclaimed uploads expire quickly; claimed ones live until their request settles. */
export const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60 * 1000;
/** Bound staged and in-flight disk use across clients, not just each request. */
export const MAX_STAGED_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_STAGED_ATTACHMENT_COUNT = 100;

export class AttachmentUploadError extends Error {
  override name = "AttachmentUploadError";

  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface StagedAttachment {
  uploadId: string;
  name: string;
  path: string;
  size: number;
  mediaType: AttachmentMediaType;
  contentHash: string;
}

interface UploadRecord extends StagedAttachment {
  createdAt: number;
  claimed: boolean;
}

const uploads = new Map<string, UploadRecord>();
const inFlight = new Set<string>();
let bytesInUse = 0;

function prepareUploadDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(UPLOADS_DIR, 0o700);
}

function uploadPath(uploadId: string): string {
  return join(UPLOADS_DIR, uploadId);
}

/** Delete files whose in-memory capabilities no longer exist, such as after restart. */
export function resetAttachmentUploads(): void {
  rmSync(UPLOADS_DIR, { recursive: true, force: true });
  uploads.clear();
  inFlight.clear();
  bytesInUse = 0;
  prepareUploadDir();
}

/** Remove expired unclaimed uploads and any unregistered files left by an interrupted write. */
export function sweepAttachmentUploads(now = Date.now()): void {
  prepareUploadDir();
  for (const [uploadId, upload] of uploads) {
    if (upload.claimed || now - upload.createdAt < ATTACHMENT_UPLOAD_TTL_MS) continue;
    rmSync(upload.path, { force: true });
    uploads.delete(uploadId);
    bytesInUse -= upload.size;
  }
  const registered = new Set([
    ...[...uploads.values()].map((upload) => upload.path),
    ...inFlight,
  ]);
  for (const name of readdirSync(UPLOADS_DIR)) {
    const path = join(UPLOADS_DIR, name);
    if (registered.has(path)) continue;
    try {
      if (now - statSync(path).mtimeMs >= ATTACHMENT_UPLOAD_TTL_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // A concurrent cleanup or failed upload may already have removed it.
    }
  }
}

export function startAttachmentUploadCleanupLoop(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      sweepAttachmentUploads();
    } catch (error) {
      console.warn(`[wisp] attachment upload cleanup failed: ${String(error)}`);
    }
  }, ATTACHMENT_UPLOAD_TTL_MS);
}

function appendHead(head: Buffer, chunk: Uint8Array, length: number): number {
  const count = Math.min(chunk.byteLength, head.byteLength - length);
  if (count > 0) head.set(chunk.subarray(0, count), length);
  return length + count;
}

function controlBytesAreText(chunk: Uint8Array): boolean {
  for (const byte of chunk) {
    if (byte < 0x80 && hasNonTextByte(byte)) return false;
  }
  return true;
}

async function closeWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  const closed = once(stream, "close");
  stream.end();
  await closed;
}

/**
 * Stream one request body to a mode-0600 temporary file while enforcing the
 * per-file ceiling. Only a 4 KiB sniff window and the current network chunk
 * are retained in memory.
 */
export async function stageAttachmentUpload(
  request: Request,
  name: string,
  maxBytes: number,
): Promise<StagedAttachment> {
  if (!request.body) throw new AttachmentUploadError("attachment upload body is required");
  if (name.length === 0) throw new AttachmentUploadError("attachment name must not be empty");
  if (name.length > 255) throw new AttachmentUploadError("attachment name must be at most 255 characters");
  sweepAttachmentUploads();
  if (uploads.size + inFlight.size >= MAX_STAGED_ATTACHMENT_COUNT) {
    throw new AttachmentUploadError("too many temporary attachment uploads; retry later", 429);
  }
  const uploadId = randomUUID();
  const path = uploadPath(uploadId);
  inFlight.add(path);
  const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const reader = request.body.getReader();
  const head = Buffer.alloc(SNIFF_WINDOW_BYTES);
  const hash = createHash("sha256");
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let reserved = 0;
  let headLength = 0;
  let validText = true;
  try {
    await once(output, "open");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AttachmentUploadError(`attachment is over the ${maxBytes} byte per-file limit`, 413);
      }
      if (bytesInUse + value.byteLength > MAX_STAGED_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AttachmentUploadError("temporary attachment upload storage is full; retry later", 429);
      }
      bytesInUse += value.byteLength;
      reserved += value.byteLength;
      headLength = appendHead(head, value, headLength);
      hash.update(value);
      if (validText) {
        validText = controlBytesAreText(value);
        if (validText) {
          try {
            utf8.decode(value, { stream: true });
          } catch {
            validText = false;
          }
        }
      }
      if (!output.write(value)) await once(output, "drain");
    }
    if (size === 0) throw new AttachmentUploadError(`${name}: empty file`);
    if (validText) {
      try {
        utf8.decode();
      } catch {
        validText = false;
      }
    }
    const sniffed = sniffAttachmentHeader(head.subarray(0, headLength));
    const mediaType = sniffed === "text/plain" && !validText ? null : sniffed;
    if (!mediaType) throw new AttachmentUploadError(`${name}: not a supported attachment (magic-byte sniff)`);
    await closeWriteStream(output);
    const staged: UploadRecord = {
      uploadId,
      name,
      path,
      size,
      mediaType,
      contentHash: hash.digest("hex"),
      createdAt: Date.now(),
      claimed: false,
    };
    uploads.set(uploadId, staged);
    return staged;
  } catch (error) {
    bytesInUse -= reserved;
    output.destroy();
    rmSync(path, { force: true });
    throw error;
  } finally {
    inFlight.delete(path);
    try {
      reader.releaseLock();
    } catch {
      // A source with a pending cancel may retain the lock until it settles.
    }
  }
}

/** Atomically reserve a one-shot upload reference for one create/send request. */
export function claimAttachmentUpload(uploadId: string, expectedName: string): StagedAttachment {
  const upload = uploads.get(uploadId);
  if (!upload) {
    throw new AttachmentUploadError(`attachment upload '${uploadId}' does not exist or expired`, 404);
  }
  if (upload.name !== expectedName) {
    throw new AttachmentUploadError(`attachment upload '${uploadId}' belongs to ${JSON.stringify(upload.name)}`);
  }
  if (upload.claimed) throw new AttachmentUploadError(`attachment upload '${uploadId}' is already in use`, 409);
  upload.claimed = true;
  return { ...upload };
}

/** Move a claimed upload into durable task storage and retire its capability. */
export function consumeAttachmentUpload(uploadId: string, destination: string): void {
  const upload = uploads.get(uploadId);
  if (!upload?.claimed) throw new Error(`attachment upload '${uploadId}' is not claimed`);
  renameSync(upload.path, destination);
  uploads.delete(uploadId);
  bytesInUse -= upload.size;
}

/** Release any claimed references that did not reach durable task storage. */
export function releaseAttachmentUpload(uploadId: string): void {
  const upload = uploads.get(uploadId);
  if (!upload?.claimed) return;
  rmSync(upload.path, { force: true });
  uploads.delete(uploadId);
  bytesInUse -= upload.size;
}

/** Delete a staged upload before it is ever claimed (route-level rejection). */
export function discardAttachmentUpload(uploadId: string): void {
  const upload = uploads.get(uploadId);
  // A client may lose the successful create response and issue best-effort
  // cleanup while launch is still using the claim. Submission owns it now.
  if (!upload || upload.claimed) return;
  rmSync(upload.path, { force: true });
  uploads.delete(uploadId);
  bytesInUse -= upload.size;
}
