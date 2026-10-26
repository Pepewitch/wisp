// A turn's source (TurnSource) as the conversation routes serve it: read
// from what its message was created with, never from the text, so a person's
// words stay theirs whatever they say, and an older row keeps its bubble.
import { afterEach, describe, expect, test } from "bun:test";
import { conversationDetail } from "../src/routes/task-conversation";
import {
  createTask, createTaskMessage, createTurn, db, freeSlot, getTask, markTaskMessageDelivered, newTaskId, setTaskFields, transition,
} from "../src/store";
import type { TurnSource } from "../src/types";

const created: string[] = [];
afterEach(() => { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); });

function task(): string {
  const id = newTaskId();
  createTask({ id, title: "sources", repo_path: "/fixture", harness: "fake", model: null, mode: "worktree", slot: freeSlot() });
  created.push(id);
  setTaskFields(id, { worktree_path: "/fixture", branch: `wisp/${id}` });
  transition(id, "done");
  return id;
}

/** Turn `n` of `taskId`, started by a message created as given. */
function turnFrom(taskId: string, n: number, text: string, message: { origin?: "workflow"; source?: TurnSource } = {}): string {
  const id = `msrc${taskId}${n}`;
  createTaskMessage({ id, taskId, text, attachmentHash: "", ...message }, false);
  markTaskMessageDelivered(id, "started", n);
  createTurn(taskId, n, text, null, "/fixture/log", null, null, null, undefined, null, id);
  setTaskFields(taskId, { turn_count: n });
  return id;
}

const served = (taskId: string) => conversationDetail(getTask(taskId)!, {}).turns.map((turn) => turn.source);

describe("a turn's source", () => {
  test("is the one its message was created with; a person's words have none, even when they read like Wisp's", () => {
    const id = task();
    const fix: TurnSource = { by: "autopilot", kind: "auto-fix", pr: 12, round: 2, rounds: 5 };
    turnFrom(id, 1, "[Wisp auto-fix · PR #12 · round 1 of 5 · head abcdef0]\nI typed this myself");
    turnFrom(id, 2, "[Wisp auto-fix · PR #12 · round 2 of 5 · head abcdef0]", { origin: "workflow", source: fix });
    turnFrom(id, 3, "[Wisp heartbeat w1]", { origin: "workflow", source: { by: "workflow", kind: "heartbeat" } });
    expect(served(id)).toEqual([null, fix, { by: "workflow", kind: "heartbeat" }]);
  });

  test("is null for a row from before sources, and for a stored blob that does not parse", () => {
    const id = task();
    // Wisp wrote it (origin), but nothing says which part of Wisp: no label is guessed
    turnFrom(id, 1, "[Wisp auto-fix · PR #3 · round 1 of 5 · head abcdef0]", { origin: "workflow" });
    const broken = turnFrom(id, 2, "a heartbeat", { origin: "workflow" });
    db.run("UPDATE task_messages SET source_json = ? WHERE id = ?", ["{not json", broken]);
    expect(served(id)).toEqual([null, null]);
  });

  test("is never relayed raw on the message", () => {
    const id = task();
    turnFrom(id, 1, "round", { origin: "workflow", source: { by: "workflow", kind: "heartbeat" } });
    expect(conversationDetail(getTask(id)!, {}).messages[0]).not.toHaveProperty("source_json");
  });
});
