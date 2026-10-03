import { outputImageUrl } from "../../../shared/api/outputs";
import { MAX_OUTPUT_IMAGE_BYTES, OutputError, outputImagePath, parseOutputManifest, publishOutputImage } from "../outputs";
import { getTask, turnForTask } from "../store";
import { err, json } from "./http";
import { serveAttachment } from "./task-messages";

/** Authenticated, manifest-scoped outputs; never accepts a path on the daemon host. */
export function outputRoute(req: Request, url: URL, path: string, method: string): Response | Promise<Response> | null {
  const match = /^\/api\/tasks\/([a-z0-9]+)\/outputs\/([1-9]\d*)(?:\/([a-f0-9]{64}))?$/.exec(path);
  if (!match) return null;
  const [, taskId, turnRaw, imageId] = match;
  if (method !== "GET" && (method !== "POST" || imageId)) return err("method not allowed", 405);
  const task = getTask(taskId!);
  if (!task) return err("no such task", 404);
  const turn = turnForTask(task.id, Number(turnRaw));
  if (!turn) return err("no such turn", 404);
  if (task.purge_pending) return err("Permanent deletion is in progress.", 410);
  const outputs = parseOutputManifest(turn.outputs_json);
  if (method === "GET") {
    if (!imageId) return json({ outputs });
    const image = outputs.find((candidate) => candidate.id === imageId);
    if (!image) return err("no such output image", 404);
    if (task.archived && !task.archive_assets_retained) return err("Output image was removed when this task was archived", 410);
    return serveAttachment(outputImagePath(task.id, turn.n, image.id), image.name, "Output image is recorded but its file is missing");
  }
  if (task.archived) return err("archived tasks cannot receive outputs", 409);
  const name = url.searchParams.get("name");
  if (!name || name.length > 1024) return err("output image name is required (up to 1024 characters)", 400);
  return (async () => {
    try {
      const bytes = await boundedImageBody(req);
      const image = publishOutputImage(turn.id, bytes, name, "published");
      return json({ image, url: outputImageUrl(task.id, turn.n, image.id) }, 201);
    } catch (error) {
      if (error instanceof OutputError) return err(error.message, error.status);
      throw error;
    }
  })();
}

async function boundedImageBody(req: Request): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length")) > MAX_OUTPUT_IMAGE_BYTES) throw new OutputError("output image exceeds the 8 MiB limit", 413);
  if (!req.body) throw new OutputError("output image is empty");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_IMAGE_BYTES) {
        await reader.cancel();
        throw new OutputError("output image exceeds the 8 MiB limit", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
