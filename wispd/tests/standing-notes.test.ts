import { beforeEach, describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { isCompaction } from "../src/adapters/context";
import { IncrementalOutcomeReducer } from "../src/adapters/outcome";
import type { TurnNotes } from "../src/autopilot/store";
import { forgetStandingNotes, NOTES_CHANGED, NOTES_RETIRED, resetStandingNotes, standingTurnNotes } from "../src/standing-notes";

const REMINDER = "To show an image, run wisp output add <image-path>.";
const MERGE = "Auto-merge is on for this task.";
const FINISHED = "PR #7 was merged by Wisp. Its branch is finished.";

function autopilot(notes: string[], once: string[] = []): TurnNotes & { spent: number } {
  const value = { notes, once, marked: false, spent: 0, delivered() { value.spent++; } };
  return value;
}

/** One turn: what it carries, recorded as delivered. */
function turn(task: { id: string; context_n: number; session_id: string | null }, notes: TurnNotes | null = null): string[] {
  const result = standingTurnNotes(task, notes, [REMINDER]);
  result.delivered();
  return result.notes;
}

beforeEach(() => resetStandingNotes());

describe("standing notes go into a conversation once", () => {
  test("the first turn carries them; the same conversation's next turns do not", () => {
    const task = { id: "t1", context_n: 1, session_id: null };
    expect(turn(task)).toEqual([REMINDER]);
    // the first turn started the session the harness then reported
    const resumed = { ...task, session_id: "s1" };
    expect(turn(resumed)).toEqual([]);
    expect(turn(resumed)).toEqual([]);
  });

  test("a new context, another session, or no session to resume gets them again", () => {
    const task = { id: "t2", context_n: 1, session_id: "s1" };
    expect(turn(task)).toEqual([REMINDER]);
    expect(turn(task)).toEqual([]);
    expect(turn({ ...task, session_id: "s2" })).toEqual([REMINDER]);
    expect(turn({ ...task, session_id: "s2" })).toEqual([]);
    expect(turn({ ...task, context_n: 2, session_id: null })).toEqual([REMINDER]);
    // a harness that never reports a session starts a conversation every turn
    expect(turn({ ...task, context_n: 2, session_id: null })).toEqual([REMINDER]);
  });

  test("changed notes are sent whole, replacing the earlier ones; a removed one is gone for the agent too", () => {
    const task = { id: "t3", context_n: 1, session_id: "s1" };
    expect(turn(task)).toEqual([REMINDER]);
    expect(turn(task, autopilot([MERGE]))).toEqual([NOTES_CHANGED, MERGE, REMINDER]);
    expect(turn(task, autopilot([MERGE]))).toEqual([]);
    expect(turn(task, autopilot([]))).toEqual([NOTES_CHANGED, REMINDER]);
    expect(turn(task)).toEqual([]);
  });

  test("an empty set that replaces notes says they no longer apply", () => {
    const task = { id: "t4", context_n: 1, session_id: "s1" };
    const first = standingTurnNotes(task, autopilot([MERGE]), []);
    first.delivered();
    expect(first.notes).toEqual([MERGE]);
    const second = standingTurnNotes(task, null, []);
    expect(second.notes).toEqual([NOTES_RETIRED]);
    second.delivered();
    expect(standingTurnNotes(task, null, []).notes).toEqual([]);
  });

  test("a one-time note is sent whenever present, and is not what the record compares", () => {
    const task = { id: "t5", context_n: 1, session_id: "s1" };
    expect(turn(task, autopilot([MERGE]))).toEqual([MERGE, REMINDER]);
    const once = autopilot([FINISHED, MERGE], [FINISHED]);
    expect(turn(task, once)).toEqual([FINISHED]);
    expect(once.spent).toBe(1);
    expect(turn(task, autopilot([MERGE]))).toEqual([]);
  });

  test("nothing is recorded until the turn really started", () => {
    const task = { id: "t6", context_n: 1, session_id: "s1" };
    const unstarted = standingTurnNotes(task, null, [REMINDER]);
    expect(unstarted.notes).toEqual([REMINDER]);
    // the spawn failed: delivered() never ran
    expect(turn(task)).toEqual([REMINDER]);
    expect(turn(task)).toEqual([]);
  });

  test("a compaction, a turn that did not end well, or a restart forgets them", () => {
    const task = { id: "t7", context_n: 1, session_id: "s1" };
    turn(task);
    forgetStandingNotes(task.id);
    expect(turn(task)).toEqual([REMINDER]);
    resetStandingNotes();
    expect(turn(task)).toEqual([REMINDER]);
  });
});

describe("a compaction inside a turn is seen", () => {
  test("claude's compact_boundary and codex's context_compaction item, and nothing else", () => {
    expect(isCompaction({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 1, post_tokens: 1 } })).toBe(true);
    expect(isCompaction({ type: "item.completed", item: { id: "i", type: "context_compaction" } })).toBe(true);
    expect(isCompaction({ type: "item.started", item: { id: "i", type: "context_compaction" } })).toBe(false);
    expect(isCompaction({ type: "system", subtype: "init" })).toBe(false);
    expect(isCompaction({ type: "result", result: "ok" })).toBe(false);
  });

  test("the outcome says so, and a restored checkpoint keeps it", () => {
    const reducer = new IncrementalOutcomeReducer(BUILTIN_ADAPTERS.claude!);
    reducer.pushStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }));
    expect(reducer.outcome().compacted).toBeUndefined();
    reducer.pushStdoutLine(JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 9, post_tokens: 3 } }));
    reducer.pushStdoutLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s1" }));
    expect(reducer.outcome("recorder-v1").compacted).toBe(true);
    const restored = new IncrementalOutcomeReducer(BUILTIN_ADAPTERS.claude!, reducer.checkpoint());
    expect(restored.outcome("recorder-v1").compacted).toBe(true);
    const codex = new IncrementalOutcomeReducer(BUILTIN_ADAPTERS.codex!);
    codex.pushStdoutLine(JSON.stringify({ type: "item.completed", item: { id: "c", type: "context_compaction" } }));
    expect(codex.outcome().compacted).toBe(true);
  });
});
