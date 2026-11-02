import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { samplePng } from "../scripts/harness/image-output-probe";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { outputImagePath, parseOutputManifest } from "../src/outputs";
import { startTurn } from "../src/runner";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, turnsFor } from "../src/store";

/** A Cursor turn through the real runner: its read is copied while it runs, not when it ends (#462). */

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [], repos: [],
  stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
};

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

test("a cursor turn's image read is captured as it happened, though the file changes before the turn ends", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "wisp-logged-images-"));
  const image = join(worktree, "frame.png");
  const original = samplePng();
  writeFileSync(image, original);
  const read = JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { readToolCall: { args: { path: image }, result: { success: { path: image, fileSize: original.length } } } } });
  const result = JSON.stringify({ type: "result", subtype: "success", result: "Seen.", is_error: false, session_id: "cursor-session" });
  const bin = join(mkdtempSync(join(tmpdir(), "wisp-fake-cursor-")), "cursor-agent");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${read}'\nsleep 1\nprintf 'changed' >> '${image}'\nprintf '%s\\n' '${result}'\n`);
  chmodSync(bin, 0o755);
  const def: AdapterDef = { ...BUILTIN_ADAPTERS.cursor!, bin };
  const task = createTask({ id: newTaskId(), title: "cursor image", repo_path: worktree, harness: "cursor", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: worktree });
  startTurn(getTask(task.id)!, "look at frame.png", def, cfg);
  await until(() => turnsFor(task.id)[0]?.status === "done");
  const [captured] = parseOutputManifest(turnsFor(task.id)[0]!.outputs_json);
  expect(captured).toMatchObject({ name: "frame.png", source: "native", step: { id: "call-1" } });
  expect(readFileSync(outputImagePath(task.id, 1, captured!.id))).toEqual(original);
}, 20_000);
