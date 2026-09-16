import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { subscribe } from "../src/events";
import { finalizeTurn } from "../src/runner";
import { createTask, createTurn, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";

/**
 * Where a turn's context reading lands. It is a property of the SESSION, not
 * of the turn, so it sits beside session_id on the task's context row — and it
 * is read off the stream the turn already wrote, never by asking the harness,
 * because on the harnesses that can answer `/context` the asking writes the
 * answer into the session it measures.
 *
 * The tracker arithmetic itself is pinned in context-tracker.test.ts; what is
 * pinned here is persistence, and the two ways absence must behave.
 */

const claude = BUILTIN_ADAPTERS.claude!;
const RESULT_LINE = '{"type":"result","result":"all done","session_id":"sess-live"}';

const call = (input: number, cacheRead = 0, cacheCreate = 0): string =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate },
    },
  });

function contextTask() {
  const task = createTask({
    id: newTaskId(),
    title: "context reading task",
    repo_path: "/tmp/repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-context-")) });
  return task.id;
}

/** Run one turn's stream through finalize and hand back the refreshed task. */
async function runTurn(taskId: string, n: number, out: string) {
  transition(taskId, "running", `turn ${n}`);
  const dir = mkdtempSync(join(tmpdir(), "wisp-context-turn-"));
  const outPath = join(dir, "turn.out.log");
  const errPath = join(dir, "turn.err.log");
  writeFileSync(outPath, out);
  writeFileSync(errPath, "");
  const turnId = createTurn(taskId, n, "prompt", 99999, outPath);
  await finalizeTurn(taskId, turnId, claude, 0, outPath, errPath);
  return getTask(taskId)!;
}

describe("the session's context reading", () => {
  test("the turn's LAST model call is what the session is carrying", async () => {
    const id = contextTask();
    const task = await runTurn(
      id,
      1,
      `{"type":"system","subtype":"init","session_id":"sess-live"}\n${call(32, 100_000, 655)}\n${call(32, 467_277, 655)}\n${RESULT_LINE}\n`,
    );
    expect(task.context_tokens).toBe(467_964);
  });

  test("a turn that made no model call leaves the last reading standing — absent is not zero", async () => {
    const id = contextTask();
    expect((await runTurn(id, 1, `${call(400_000)}\n${RESULT_LINE}\n`)).context_tokens).toBe(400_000);
    // an interrupted turn, or one that only ran a local command, reports none
    expect((await runTurn(id, 2, `${RESULT_LINE}\n`)).context_tokens).toBe(400_000);
  });

  test("a compaction's own boundary is a reading, so the number drops with it", async () => {
    const id = contextTask();
    const boundary = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 468_951, post_tokens: 9472 },
    });
    const task = await runTurn(id, 1, `${call(468_951)}\n${boundary}\n${RESULT_LINE}\n`);
    expect(task.context_tokens).toBe(9472);
  });

  test("the row carries the new reading BEFORE the event that tells clients to refetch", async () => {
    // This is what makes the header update on the compaction rather than one
    // turn later. The web client refetches the task LIST on the `task` event
    // (sse.ts), so a write ordered after the emit would serve the number the
    // compaction just retired, and nothing would arrive to correct it.
    const id = contextTask();
    const seen: (number | null)[] = [];
    const stop = subscribe((event) => {
      if ("taskId" in event && event.taskId === id && event.type === "task") {
        seen.push(getTask(id)!.context_tokens);
      }
    });
    try {
      await runTurn(id, 1, `${call(123_456)}\n${RESULT_LINE}\n`);
    } finally {
      stop();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(123_456);
  });

  test("a harness with no tracker never gets a number, however much usage it reports", async () => {
    const id = contextTask();
    const dir = mkdtempSync(join(tmpdir(), "wisp-context-droid-"));
    const outPath = join(dir, "turn.out.log");
    const errPath = join(dir, "turn.err.log");
    // droid's real completion shape: usage summed over the whole turn
    writeFileSync(
      outPath,
      '{"type":"completion","finalText":"done","session_id":"s-1","usage":{"input_tokens":1331021,"cache_read_input_tokens":20095847}}\n',
    );
    writeFileSync(errPath, "");
    transition(id, "running", "turn 1");
    const turnId = createTurn(id, 1, "prompt", 99999, outPath);
    await finalizeTurn(id, turnId, BUILTIN_ADAPTERS.droid!, 0, outPath, errPath);
    expect(getTask(id)!.context_tokens).toBeNull();
  });
});
