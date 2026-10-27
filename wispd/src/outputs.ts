import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputImage, OutputStep } from "../../shared/api/outputs";
import { sniffAttachmentHeader } from "../../shared/attachment-sniff";
import { TASKS_DIR } from "./config";
import { emit } from "./events";
import { openTurnCommands } from "./recording/broker";
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

const MAX_STEP_ID_CHARS = 512;
const MAX_STEP_LABEL_CHARS = 200;

/** A step anchor from harness text, or null when the harness gave no usable id. */
export function outputStep(id: string | null | undefined, label: string): OutputStep | null {
  if (!id || id.length > MAX_STEP_ID_CHARS) return null;
  const clean = label.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, MAX_STEP_LABEL_CHARS).trim();
  return { id, label: clean || "step" };
}

function parsedStep(value: unknown): OutputStep | null {
  if (!value || typeof value !== "object") return null;
  const { id, label } = value as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_STEP_ID_CHARS &&
    typeof label === "string" && label.length > 0 && label.length <= MAX_STEP_LABEL_CHARS ? { id, label } : null;
}

/** Manifests written before steps were kept stay valid; a malformed step is dropped, not the image. */
export function parseOutputManifest(raw: string | null | undefined): OutputImage[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is OutputImage => item && typeof item === "object" &&
      typeof item.id === "string" && IMAGE_ID.test(item.id) &&
      typeof item.name === "string" && item.name.length > 0 && item.name.length <= 120 &&
      Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_OUTPUT_IMAGE_BYTES &&
      IMAGE_TYPES.has(item.mediaType) && (item.source === "native" || item.source === "published"))
      .map(({ id, name, size, mediaType, source, step }) => {
        const anchor = parsedStep(step);
        return anchor ? { id, name, size, mediaType, source, step: anchor } : { id, name, size, mediaType, source };
      });
  } catch { return []; }
}

export function outputImagePath(taskId: string, turn: number, imageId: string): string {
  return join(TASKS_DIR, taskId, "outputs", `turn-${turn}`, imageId);
}

const OUTPUT_ADD = /\boutput\s+add\b/;
const CAPTURE = /\bwisp\s+capture\b/;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The step that published an image: the one open command step on its turn
 * that is that publication, or null when no step or more than one could be.
 * Never a guess from which step happens to be running, since steps run in
 * parallel. `wisp output add` must name the file (the basename the CLI
 * sends); `wisp capture` names no file, so it must be the only capture open.
 */
export function publishingStep(turnId: number, publication: { add: string } | "capture"): OutputStep | null {
  const names = publication === "capture" ? null : new RegExp(`(?:^|[\\s/'"=])${escaped(publication.add)}(?=$|[\\s'";&|)])`);
  const callers = openTurnCommands(turnId).filter(({ command }) =>
    names ? OUTPUT_ADD.test(command) && names.test(command) : CAPTURE.test(command));
  return callers.length === 1 ? callers[0]!.step : null;
}

/** Store before publishing the manifest; a failed write never advertises a missing image. */
export function publishOutputImage(
  turnId: number,
  bytes: Uint8Array,
  name: string,
  source: OutputImage["source"],
  step: OutputStep | null = null,
): OutputImage {
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
    // Sharing an image the agent had only looked at makes it shared, from the step that shared it.
    const promoted = existing?.source === "native" && source === "published" ? withStep({ ...existing, source }, step) : null;
    const image: OutputImage = promoted ?? existing ??
      withStep({ id, name: safeName, size: bytes.length, mediaType: mediaType as OutputImage["mediaType"], source }, step);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
      if (!existing) rollbackTarget = target;
      const next = promoted ? outputs.map((output) => output.id === id ? promoted : output) : existing ? null : [...outputs, image];
      if (next) db.query("UPDATE turns SET outputs_json = ? WHERE id = ?").run(JSON.stringify(next), turn.id);
    } finally { rmSync(temporary, { force: true }); }
    added = !existing || Boolean(promoted);
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

function withStep(image: OutputImage, step: OutputStep | null): OutputImage {
  const { step: _replaced, ...rest } = image;
  return step ? { ...rest, step } : rest;
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
