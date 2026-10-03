import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputImage } from "../../shared/api/outputs";
import { sniffAttachmentHeader } from "../../shared/attachment-sniff";
import { TASKS_DIR } from "./config";
import { emit } from "./events";
import { db } from "./store-database";
import { getTask, getTurn } from "./store";

// Native JSONL frames are capped at 16 MiB, including base64 and protocol overhead.
export const MAX_OUTPUT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TURN_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_TURN_OUTPUT_IMAGES = 32;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_ID = /^[a-f0-9]{64}$/;

export class OutputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function parseOutputManifest(raw: string | null | undefined): OutputImage[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is OutputImage => item && typeof item === "object" &&
      typeof item.id === "string" && IMAGE_ID.test(item.id) &&
      typeof item.name === "string" && item.name.length > 0 && item.name.length <= 120 &&
      Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_OUTPUT_IMAGE_BYTES &&
      IMAGE_TYPES.has(item.mediaType) && (item.source === "native" || item.source === "published"));
  } catch { return []; }
}

export function outputImagePath(taskId: string, turn: number, imageId: string): string {
  return join(TASKS_DIR, taskId, "outputs", `turn-${turn}`, imageId);
}

/** Store before publishing the manifest; a failed write never advertises a missing image. */
export function publishOutputImage(turnId: number, bytes: Uint8Array, name: string, source: OutputImage["source"]): OutputImage {
  if (bytes.length === 0) throw new OutputError("output image is empty");
  if (bytes.length > MAX_OUTPUT_IMAGE_BYTES) throw new OutputError("output image exceeds the 8 MiB limit", 413);
  const mediaType = sniffAttachmentHeader(bytes);
  if (!mediaType || !IMAGE_TYPES.has(mediaType)) throw new OutputError("output must be a PNG, JPEG, GIF or WebP image", 415);
  const id = createHash("sha256").update(bytes).digest("hex");
  const safeName = name.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\p{C}"<>]/gu, "_").slice(0, 120).trim() || "image";
  let added = false;
  let rollbackTarget: string | null = null;
  const persist = db.transaction(() => {
    const turn = getTurn(turnId);
    if (!turn) throw new OutputError("no such turn", 404);
    const task = getTask(turn.task_id);
    if (!task) throw new OutputError("no such task", 404);
    if (task.archived || task.purge_pending) throw new OutputError("archived or deleting tasks cannot receive outputs", 409);
    const outputs = parseOutputManifest(turn.outputs_json);
    const existing = outputs.find((image) => image.id === id);
    if (!existing && (outputs.length >= MAX_TURN_OUTPUT_IMAGES || outputs.reduce((size, image) => size + image.size, 0) + bytes.length > MAX_TURN_OUTPUT_BYTES)) {
      throw new OutputError("turn output limit reached (32 images / 64 MiB)", 413);
    }
    const dir = join(TASKS_DIR, task.id, "outputs", `turn-${turn.n}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = outputImagePath(task.id, turn.n, id);
    const temporary = `${target}.tmp-${randomUUID()}`;
    const image: OutputImage = existing ?? { id, name: safeName, size: bytes.length, mediaType: mediaType as OutputImage["mediaType"], source };
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
      if (!existing) rollbackTarget = target;
      if (!existing) db.query("UPDATE turns SET outputs_json = ? WHERE id = ?").run(JSON.stringify([...outputs, image]), turn.id);
    } finally { rmSync(temporary, { force: true }); }
    added = !existing;
    return image;
  });
  let image: OutputImage;
  try { image = persist(); }
  catch (error) {
    // A failed UPDATE or COMMIT must not leave bytes outside the manifest's
    // quotas. Previously manifested files remain available on failed retries.
    if (rollbackTarget) rmSync(rollbackTarget, { force: true });
    throw error;
  }
  if (added) {
    const turn = getTurn(turnId)!;
    emit({ type: "outputs", taskId: turn.task_id, n: turn.n, outputs: parseOutputManifest(turn.outputs_json) });
  }
  return image;
}

/** Strict base64: Buffer.from alone silently accepts malformed or truncated data. */
export function decodeOutputImage(data: unknown): Uint8Array {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 ||
      data.length > Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new OutputError("invalid or oversized base64 output image");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new OutputError("invalid base64 output image");
  return bytes;
}
