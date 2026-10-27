import { expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outputImageNote, outputImageNoteId } from "../../shared/api/outputs";
import { samplePng } from "../scripts/harness/image-output-probe";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { createOutputImageCapture } from "../src/adapters/output-images";
import { LOG_DIR, TASKS_DIR, WISP_HOME, loadConfig } from "../src/config";
import { MAX_OUTPUT_IMAGE_BYTES, outputImagePath, parseOutputManifest, publishOutputImage } from "../src/outputs";
import { TurnRecorder } from "../src/recording/turn-recorder";
import { createTask, createTurn, freeSlot, getTurn, newTaskId, setTaskFields } from "../src/store";
import { finalizeTurn } from "../src/turn-finalize";

/** A task whose worktree lives under the Wisp home, as real worktrees do. */
function fixture() {
  const task = createTask({ id: newTaskId(), title: "Step fixture", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  const worktree = join(WISP_HOME, "worktrees", `wisp-${task.id}`);
  mkdirSync(worktree, { recursive: true });
  setTaskFields(task.id, { worktree_path: worktree });
  const log = join(LOG_DIR, `${task.id}-1.log`);
  const turnId = createTurn(task.id, 1, "Look at images", null, log, null);
  return { task, worktree, turnId, log };
}

const outputs = (turnId: number) => parseOutputManifest(getTurn(turnId)!.outputs_json);
const base64 = () => samplePng().toString("base64");

function capture(harness: string, turnId: number) {
  const notes: string[] = [];
  const run = createOutputImageCapture(BUILTIN_ADAPTERS[harness]!, turnId, (note) => notes.push(note));
  return { notes, run };
}

// Shapes copied from real transcripts (claude-stream-json, droid-stream-json,
// codex-jsonl, cursor-stream-json), ids and paths synthetic, base64 shortened
// to a sample PNG.
test("claude names a Read image after its file and anchors it to the tool call", () => {
  const f = fixture();
  const { run } = capture("claude", f.turnId);
  run({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/work/repo/.context/clip-ours.png" } }] } });
  const result = run({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64() } }] }] } });
  expect(JSON.stringify(result)).not.toContain(base64());
  expect(outputs(f.turnId)).toEqual([expect.objectContaining({
    name: "clip-ours.png", source: "native", step: { id: "toolu_01", label: "Read /work/repo/.context/clip-ours.png" },
  })]);
});

test("droid captures a Read image's base64, replaces it in the transcript and anchors it", () => {
  const f = fixture();
  const { run, notes } = capture("droid", f.turnId);
  run({ type: "tool_call", id: "chatcmpl-tool-01", toolName: "Read", parameters: { file_path: "/tmp/mock/hint-desktop.png", image_quality: "high" }, timestamp: 1 });
  const result = run({ type: "tool_result", id: "chatcmpl-tool-01", value: [{ type: "text", text: "Image file: hint-desktop.png (original size: 1 KB)" }, { type: "image", source: { type: "base64", mediaType: "image/png", data: base64() } }], isError: false, timestamp: 2 });
  expect(JSON.stringify(result)).not.toContain(base64());
  expect(JSON.stringify(result)).toContain("Image file: hint-desktop.png");
  expect(JSON.stringify(result)).toContain("Image output: hint-desktop.png");
  expect(notes[0]).toContain("Image output: hint-desktop.png");
  // the web hides this note under the step that draws the image, by this id
  expect(outputImageNoteId(notes[0]!)).toBe(outputs(f.turnId)[0]!.id);
  expect(outputs(f.turnId)).toEqual([expect.objectContaining({
    name: "hint-desktop.png", step: { id: "chatcmpl-tool-01", label: "Read /tmp/mock/hint-desktop.png" },
  })]);
});

test("codex copies an image_view file from the worktree and keeps a generated image's bytes", () => {
  const f = fixture();
  const path = join(f.worktree, ".context", "installed.png");
  mkdirSync(join(f.worktree, ".context"));
  writeFileSync(path, samplePng());
  const { run, notes } = capture("codex", f.turnId);
  const view = { type: "item.completed", item: { id: "exec-view-1", type: "image_view", path }, timestamp: 1 };
  expect(run(view)).toBe(view);
  expect(notes[0]).toContain("Image output: installed.png");
  const generated = Buffer.concat([samplePng(), Buffer.from([1])]);
  const result = run({ type: "item.completed", item: { type: "image_generation", id: "exec-gen-1", status: "completed", revisedPrompt: "A chart", result: generated.toString("base64"), savedPath: "/elsewhere/.codex/generated_images/exec-gen-1.png" } });
  expect(JSON.stringify(result)).not.toContain(generated.toString("base64"));
  const [viewed, made] = outputs(f.turnId);
  expect(viewed).toEqual(expect.objectContaining({ name: "installed.png", step: { id: "exec-view-1", label: `image_view ${path}` } }));
  expect(viewed!.source).toBe("native");
  expect(made).toEqual(expect.objectContaining({ name: "exec-gen-1.png", source: "published", step: { id: "exec-gen-1", label: "image generation" } }));
  expect(readFileSync(outputImagePath(f.task.id, 1, made!.id))).toEqual(generated);
});

test("a codex image_generation result far over the transcript's 16 KB bound is captured whole, as shared", () => {
  const f = fixture();
  const outFd = openSync(f.log, "a"), errFd = openSync(`${f.log}.err`, "a");
  try {
    const recorder = new TurnRecorder(f.turnId, BUILTIN_ADAPTERS.codex!, { ...loadConfig(), diagnosticEnabled: false }, outFd, errFd);
    // a valid PNG followed by padding, the size of a real generated image
    const bytes = Buffer.concat([samplePng(), Buffer.alloc(1_000_000, 7)]);
    const result = bytes.toString("base64");
    expect(result.length).toBeGreaterThan(16 * 1024);
    recorder.recordStdoutLine(JSON.stringify({ type: "item.completed", item: { id: "ig_01", type: "image_generation", status: "completed", revised_prompt: "A chart", result, savedPath: "/elsewhere/.codex/generated_images/ig_01.png" } }));
    recorder.recordEvent({ type: "item.completed", item: { type: "agent_message", text: "Here is the chart." } });
    recorder.recordEvent({ type: "turn.completed" });
    recorder.finish();
    const [image] = outputs(f.turnId);
    expect(image).toEqual(expect.objectContaining({ name: "ig_01.png", size: bytes.length, source: "published", step: { id: "ig_01", label: "image generation" } }));
    expect(readFileSync(outputImagePath(f.task.id, 1, image!.id))).toEqual(bytes);
    const log = readFileSync(f.log, "utf8");
    expect(log).not.toContain(result.slice(0, 4096));
    expect(log).toContain(outputImageNote(image!));
  } finally { closeSync(outFd); closeSync(errFd); }
});

test("cursor copies a completed readToolCall of an image in the task's own files", () => {
  const f = fixture();
  const dir = join(TASKS_DIR, f.task.id, "attachments", "turn-1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "image.png");
  writeFileSync(path, samplePng());
  const callId = "call-0001-0\nfc_0001_0";
  const { run } = capture("cursor", f.turnId);
  run({ type: "tool_call", subtype: "started", call_id: callId, tool_call: { readToolCall: { args: { path } } } });
  expect(outputs(f.turnId)).toEqual([]);
  run({ type: "tool_call", subtype: "completed", call_id: callId, tool_call: { readToolCall: { args: { path }, result: { success: { isEmpty: false, totalLines: 0, fileSize: samplePng().length, path, dataBlobId: "blob" } } } } });
  expect(outputs(f.turnId)).toEqual([expect.objectContaining({ name: "image.png", step: { id: callId, label: `read ${path}` } })]);
});

test("a cursor turn's finished log is captured once it settles, without a second copy on a second settle", async () => {
  const f = fixture();
  const path = join(f.worktree, "shot.png");
  writeFileSync(path, samplePng());
  const read = { type: "tool_call", subtype: "completed", call_id: "call-log-1", tool_call: { readToolCall: { args: { path }, result: { success: { path, fileSize: 1 } } } } };
  writeFileSync(f.log, [
    JSON.stringify({ type: "tool_call", subtype: "started", call_id: "call-log-1", tool_call: { readToolCall: { args: { path } } } }),
    JSON.stringify(read),
    JSON.stringify({ type: "result", subtype: "success", result: "Seen.", is_error: false }),
  ].join("\n") + "\n");
  writeFileSync(`${f.log}.err`, "");
  for (let settle = 0; settle < 2; settle++) await finalizeTurn(f.task.id, f.turnId, BUILTIN_ADAPTERS.cursor!, 0, f.log, `${f.log}.err`);
  expect(outputs(f.turnId)).toEqual([expect.objectContaining({ name: "shot.png", step: { id: "call-log-1", label: `read ${path}` } })]);
  expect(readFileSync(f.log, "utf8")).toContain("· Image output: shot.png");
});

test("opencode captures a read tool's data-URL attachment", () => {
  const f = fixture();
  const { run } = capture("opencode", f.turnId);
  const result = run({ type: "tool_use", part: { type: "tool", tool: "read", callID: "call_01", state: { status: "completed", input: { filePath: "/work/repo/shot.png" }, output: "Image read successfully", attachments: [{ id: "prt_01", type: "file", mime: "image/png", url: `data:image/png;base64,${base64()}` }] } } });
  expect(JSON.stringify(result)).not.toContain(base64());
  expect(outputs(f.turnId)).toEqual([expect.objectContaining({ name: "shot.png", step: { id: "call_01", label: "read /work/repo/shot.png" } })]);
});

test("unsafe paths are refused and the transcript says why", () => {
  const f = fixture();
  const secret = join(WISP_HOME, "not-this-task.png");
  writeFileSync(secret, samplePng());
  symlinkSync(secret, join(f.worktree, "link.png"));
  writeFileSync(join(f.worktree, "notes.png"), "not an image");
  writeFileSync(join(f.worktree, "huge.png"), Buffer.concat([samplePng(), Buffer.alloc(MAX_OUTPUT_IMAGE_BYTES)]));
  const { run, notes } = capture("codex", f.turnId);
  for (const path of [secret, join(f.worktree, "link.png"), join(f.worktree, "notes.png"), join(f.worktree, "huge.png"), "relative.png", join(f.worktree, "missing.png")]) {
    run({ type: "item.completed", item: { id: `view-${path}`, type: "image_view", path } });
  }
  expect(notes).toEqual([
    "· Image output unavailable: the image is outside the task's worktree, its Wisp files and the temp directory",
    "· Image output unavailable: the image is outside the task's worktree, its Wisp files and the temp directory",
    "· Image output unavailable: output must be a PNG, JPEG, GIF or WebP image",
    "· Image output unavailable: output image exceeds the 8 MiB limit",
    "· Image output unavailable: the image path is not absolute",
    "· Image output unavailable: the image file was not found",
  ]);
  expect(outputs(f.turnId)).toEqual([]);
});

test("published images take the running command step; sharing a viewed image promotes it", () => {
  const f = fixture();
  const outFd = openSync(f.log, "a"), errFd = openSync(`${f.log}.err`, "a");
  try {
    const recorder = new TurnRecorder(f.turnId, BUILTIN_ADAPTERS.claude!, { ...loadConfig(), diagnosticEnabled: false }, outFd, errFd);
    const viewed = Buffer.concat([samplePng(), Buffer.from([7])]);
    recorder.recordEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/before.png" } }] } });
    recorder.recordEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: viewed.toString("base64") } }] }] } });
    recorder.recordEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "wisp output add before.png --turn 1" } }] } });
    const shared = publishOutputImage(f.turnId, samplePng(), "after.png", "published");
    expect(shared.step).toEqual({ id: "toolu_bash", label: "wisp output add before.png --turn 1" });
    const promoted = publishOutputImage(f.turnId, viewed, "before.png", "published");
    expect(promoted).toEqual(expect.objectContaining({ name: "before.png", source: "published", step: { id: "toolu_bash", label: "wisp output add before.png --turn 1" } }));
    recorder.recordEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "published" }] } });
    expect(publishOutputImage(f.turnId, Buffer.concat([samplePng(), Buffer.from([8])]), "late.png", "published").step).toBeUndefined();
    expect(outputs(f.turnId).map((image) => [image.name, image.source, image.step?.id ?? null])).toEqual([
      ["before.png", "published", "toolu_bash"],
      ["after.png", "published", "toolu_bash"],
      ["late.png", "published", null],
    ]);
    recorder.finish();
    expect(publishOutputImage(f.turnId, Buffer.concat([samplePng(), Buffer.from([9])]), "after-turn.png", "published").step).toBeUndefined();
  } finally { closeSync(outFd); closeSync(errFd); }
});

test("manifests without steps still parse, and a malformed step drops only the step", () => {
  const image = { id: "a".repeat(64), name: "old.png", size: 10, mediaType: "image/png", source: "native" };
  expect(parseOutputManifest(JSON.stringify([image]))).toEqual([image as never]);
  expect(parseOutputManifest(JSON.stringify([{ ...image, step: { id: 4 } }, { ...image, id: "b".repeat(64), step: { id: "s1", label: "Read x.png", extra: true } }]))).toEqual([
    image as never,
    { ...image, id: "b".repeat(64), step: { id: "s1", label: "Read x.png" } } as never,
  ]);
});
