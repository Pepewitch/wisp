import { expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { samplePng } from "../scripts/harness/image-output-probe";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { externalizeOutputImages } from "../src/adapters/output-images";
import { LOG_DIR, loadConfig } from "../src/config";
import { subscribe } from "../src/events";
import { decodeOutputImage, MAX_OUTPUT_IMAGE_BYTES, outputImagePath, parseOutputManifest, publishOutputImage } from "../src/outputs";
import { TurnRecorder } from "../src/recording/turn-recorder";
import { apiTurn } from "../src/routes/http";
import { outputRoute } from "../src/routes/outputs";
import { createTask, createTurn, db, finishTurn, freeSlot, getTask, getTurn, newTaskId, setTaskFields, transition } from "../src/store";
import { exportTask, purgeTask, taskStorage } from "../src/task-retention";

function fixture() {
  const task = createTask({ id: newTaskId(), title: "Output fixture", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  const log = join(LOG_DIR, `${task.id}-1.log`);
  const turnId = createTurn(task.id, 1, "Show an image", null, log, null);
  return { task, turnId, log };
}

async function request(taskId: string, suffix = "", options?: RequestInit) {
  const req = new Request(`http://fixture/api/tasks/${taskId}/outputs/1${suffix}`, options);
  const url = new URL(req.url);
  return await outputRoute(req, url, url.pathname, req.method)!;
}

test("publication is manifest-scoped, byte-sniffed, deduplicated, and emits an output refresh", async () => {
  const f = fixture();
  const events: unknown[] = [];
  const off = subscribe((event) => events.push(event));
  try {
    const image = publishOutputImage(f.turnId, samplePng(), "../../screenshot.jpg", "published");
    expect(image.name).toBe("screenshot.jpg");
    expect(image.mediaType).toBe("image/png");
    expect(publishOutputImage(f.turnId, samplePng(), "duplicate.png", "native")).toEqual(image);
    expect(apiTurn(getTurn(f.turnId)!).outputs).toEqual([image]);
    expect(apiTurn(getTurn(f.turnId)!)).not.toHaveProperty("outputs_json");
    expect(events).toEqual([{ type: "outputs", taskId: f.task.id, n: 1 }]);
    const response = await request(f.task.id, `/${image.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(samplePng());
    expect((await request(fixture().task.id, `/${image.id}`)).status).toBe(404);
    rmSync(outputImagePath(f.task.id, 1, image.id));
    expect((await request(f.task.id, `/${image.id}`)).status).toBe(410);
    publishOutputImage(f.turnId, samplePng(), "restore.png", "published");
    expect((await request(f.task.id, `/${image.id}`)).status).toBe(200);
  } finally { off(); }
});

test("raw publication refuses unsupported files and oversized chunked bodies without registering them", async () => {
  const f = fixture();
  expect((await request(f.task.id, "?name=plot.png", { method: "POST", body: samplePng() })).status).toBe(201);
  expect((await request(f.task.id, "?name=plot.svg", { method: "POST", body: "<svg onload='alert(1)'/>" })).status).toBe(415);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_OUTPUT_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  expect((await request(f.task.id, "?name=large.png", { method: "POST", body: stream })).status).toBe(413);
  expect(parseOutputManifest(getTurn(f.turnId)!.outputs_json)).toHaveLength(1);
  expect(() => decodeOutputImage("a!b=")).toThrow();
  expect(() => decodeOutputImage("Zh==")).toThrow();
  expect(() => decodeOutputImage("A".repeat(Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3) * 4 + 4))).toThrow();
  expect(() => publishOutputImage(f.turnId, new Uint8Array(), "empty.png", "published")).toThrow("empty");
});

test("count and byte limits cannot grow a turn indefinitely", () => {
  const f = fixture();
  for (let n = 0; n < 32; n++) publishOutputImage(f.turnId, Buffer.concat([samplePng(), Buffer.from([n])]), "plot.png", "native");
  expect(() => publishOutputImage(f.turnId, samplePng(), "extra.png", "native")).toThrow("turn output limit");
  const g = fixture();
  const image = publishOutputImage(g.turnId, samplePng(), "plot.png", "published");
  db.query("UPDATE turns SET outputs_json = ? WHERE id = ?").run(JSON.stringify(Array.from({ length: 8 }, (_, n) => ({ ...image, id: n.toString(16).padStart(64, "0"), size: MAX_OUTPUT_IMAGE_BYTES }))), g.turnId);
  expect(() => publishOutputImage(g.turnId, samplePng(), "extra.png", "native")).toThrow("turn output limit");
});

// Sanitized shapes from the synthetic MCP probe: Codex 0.159.2 and Claude 2.1.288.
function codexImage(data = samplePng().toString("base64")) {
  return { type: "item.completed", item: { id: "probe", type: "mcp_tool_call", server: "imageprobe", tool: "sample_image", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "Synthetic stripes" }, { type: "image", data, mimeType: "image/png" }], structured_content: null }, error: null } };
}

function claudeImage() {
  return { type: "user", parent_tool_use_id: "child-agent", message: { content: [{ type: "tool_result", tool_use_id: "probe", content: [{ type: "text", text: "Synthetic stripes" }, { type: "image", source: { type: "base64", media_type: "image/png", data: samplePng().toString("base64") } }] }] } };
}

test("verified native shapes preserve adjacent text and subagent scope; unknown harnesses do not guess", () => {
  for (const [name, event] of [["codex", codexImage()], ["claude", claudeImage()]] as const) {
    const f = fixture();
    const notes: string[] = [];
    const output = externalizeOutputImages(event, BUILTIN_ADAPTERS[name]!, f.turnId, (note) => notes.push(note));
    expect(JSON.stringify(output)).toContain("Synthetic stripes");
    expect(JSON.stringify(output)).not.toContain(samplePng().toString("base64"));
    expect(parseOutputManifest(getTurn(f.turnId)!.outputs_json)).toHaveLength(1);
    expect(notes[0]).toContain("Image output:");
    if (name === "claude") expect(output.parent_tool_use_id).toBe("child-agent");
  }
  const f = fixture(), event = codexImage();
  expect(externalizeOutputImages(event, BUILTIN_ADAPTERS.cursor!, f.turnId, () => {})).toBe(event);
  expect(getTurn(f.turnId)!.outputs_json).toBeNull();
  const output = externalizeOutputImages(codexImage("bad!"), BUILTIN_ADAPTERS.codex!, f.turnId, () => {});
  expect(JSON.stringify(output)).toContain("Image output unavailable");
  expect(JSON.stringify(output)).not.toContain("bad!");
});

test("recorder saves images before bounding the protocol and ignores late events after sealing", () => {
  const f = fixture();
  const outFd = openSync(f.log, "a"), errFd = openSync(`${f.log}.err`, "a");
  try {
    const recorder = new TurnRecorder(f.turnId, BUILTIN_ADAPTERS.codex!, { ...loadConfig(), diagnosticEnabled: false, turnTranscriptBytes: 4096 }, outFd, errFd);
    const bytes = Buffer.concat([samplePng(), Buffer.alloc(40_000)]);
    recorder.recordStdoutLine(JSON.stringify(codexImage(bytes.toString("base64"))));
    recorder.recordEvent({ type: "item.completed", item: { type: "agent_message", text: "Here is your image." } });
    recorder.recordEvent({ type: "turn.completed" });
    expect(recorder.finish().parsed.result).toBe("Here is your image.");
    const image = parseOutputManifest(getTurn(f.turnId)!.outputs_json)[0]!;
    expect(readFileSync(outputImagePath(f.task.id, 1, image.id))).toEqual(bytes);
    expect(readFileSync(f.log, "utf8")).not.toContain(bytes.toString("base64"));
    recorder.recordEvent(codexImage());
    expect(parseOutputManifest(getTurn(f.turnId)!.outputs_json)).toHaveLength(1);
  } finally { closeSync(outFd); closeSync(errFd); }
});

test("output bytes survive archive, join export/storage, and disappear with permanent deletion", async () => {
  const f = fixture();
  const fd = openSync(f.log, "a"); closeSync(fd);
  const image = publishOutputImage(f.turnId, samplePng(), "plot.png", "published");
  finishTurn(f.turnId, "done", 0, "See the image"); transition(f.task.id, "done");
  setTaskFields(f.task.id, { archived: 1, archive_assets_retained: 1 });
  expect((await request(f.task.id, `/${image.id}`)).status).toBe(200);
  expect((await request(f.task.id, "?name=new.png", { method: "POST", body: samplePng() })).status).toBe(409);
  expect(() => publishOutputImage(f.turnId, samplePng(), "new.png", "native")).toThrow("archived");
  expect((await taskStorage(getTask(f.task.id)!)).files).toBe(2);
  const exported = await exportTask(getTask(f.task.id)!);
  expect(exported.files.some((file) => file.dataBase64 === samplePng().toString("base64"))).toBe(true);
  rmSync(outputImagePath(f.task.id, 1, image.id));
  expect((await exportTask(getTask(f.task.id)!)).missing.some((path) => path.includes(image.id))).toBe(true);
  await purgeTask(getTask(f.task.id)!);
  expect(getTask(f.task.id)).toBeNull();
  expect(existsSync(outputImagePath(f.task.id, 1, image.id))).toBe(false);
});
