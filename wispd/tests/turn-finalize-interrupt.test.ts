import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { finalizeTurn, markInterrupted } from "../src/runner";
import {
  createTask,
  createTurn,
  freeSlot,
  getTask,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
} from "../src/store";

const jsonAdapter: AdapterDef = {
  bin: "true",
  exec: [],
  parse: { format: "json", resultType: "result", result: "result", session: "session_id" },
  attach: null,
};

function makeTask() {
  const task = createTask({
    id: newTaskId(),
    title: "interrupt detail test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-interrupt-")) });
  transition(task.id, "running", "turn 1");
  return task;
}

test("an interrupted turn whose harness reported an error names it in needs-input", async () => {
  // A steer that died at harness startup (error event, no result) must not
  // read as a plain user stop: the state detail carries the harness's words.
  const task = makeTask();
  const dir = mkdtempSync(join(tmpdir(), "wisp-interrupt-"));
  const outPath = join(dir, "turn.out.log");
  const errPath = join(dir, "turn.err.log");
  writeFileSync(outPath, '{"type":"completion","finalText":"Droid turn error","session_id":"s","isError":true}\n');
  const turnId = createTurn(task.id, 1, "prompt", 99999, outPath);
  markInterrupted(turnId, "turn interrupted — session kept, send a message to continue");
  const droidLike: AdapterDef = {
    ...jsonAdapter,
    parse: { format: "json", resultType: "completion", result: "finalText", session: "session_id" },
    errors: "droid-stream-json",
  };

  await finalizeTurn(task.id, turnId, droidLike, 137, outPath, errPath);

  expect(turnsFor(task.id)[0]!.status).toBe("interrupted");
  const after = getTask(task.id)!;
  expect(after.state).toBe("needs-input");
  expect(after.state_detail).toContain("send a message to continue");
  expect(after.state_detail).toContain("The harness last reported: Droid turn error");
});

test("an interrupted turn with no harness error keeps the plain stop detail", async () => {
  const task = makeTask();
  const dir = mkdtempSync(join(tmpdir(), "wisp-interrupt-"));
  const outPath = join(dir, "turn.out.log");
  const errPath = join(dir, "turn.err.log");
  writeFileSync(outPath, '{"type":"completion","finalText":"partial answer","session_id":"s"}\n');
  const turnId = createTurn(task.id, 1, "prompt", 99999, outPath);
  markInterrupted(turnId, "turn interrupted — session kept, send a message to continue");

  await finalizeTurn(task.id, turnId, jsonAdapter, 137, outPath, errPath);

  expect(getTask(task.id)!.state).toBe("needs-input");
  expect(getTask(task.id)!.state_detail).toBe("turn interrupted — session kept, send a message to continue");
});
