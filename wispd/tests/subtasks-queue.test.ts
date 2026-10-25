// A queued subtask report is Wisp's: it never starts a turn on its own, a
// person's message behind it still does, nobody can rewrite or rush it, and
// autopilot does not count its parent idle while it waits.
import { describe, expect, test } from "bun:test";
import { canTakeReport, taskIsIdle } from "../src/autopilot/idle";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { taskMessageRoute, taskMessageSendNowRoute } from "../src/routes/task-messages";
import {
  createTask, createTaskMessage, db, freeSlot, getTask, isQueueHead, newTaskId, nextQueuedMessage, releaseTaskMessageHold,
  setTaskFields, transition, updateQueuedTaskMessage,
} from "../src/store";
import type { TaskCompactor } from "../src/compacts";

function idleTask(): string {
  const id = newTaskId();
  createTask({ id, title: "parent", repo_path: "/fixture", harness: "fake", model: null, mode: "local", slot: freeSlot() });
  setTaskFields(id, { worktree_path: "/fixture", branch: "main" });
  transition(id, "done");
  return id;
}

const message = (taskId: string, id: string, origin: "human" | "subtask") =>
  createTaskMessage({ id, taskId, text: `${origin} words`, attachmentHash: "", origin }, false);

describe("a queued subtask report", () => {
  test("starts only when named; a person's message behind it is the head", () => {
    const parent = idleTask();
    message(parent, `mreport${parent}`, "subtask");
    expect(nextQueuedMessage(parent)).toBeNull();
    expect(nextQueuedMessage(parent, `mreport${parent}`)?.id).toBe(`mreport${parent}`);
    message(parent, `mperson${parent}`, "human");
    expect(nextQueuedMessage(parent)?.id).toBe(`mperson${parent}`);
    expect(isQueueHead(`mperson${parent}`, parent)).toBe(true);
    expect(isQueueHead(`mreport${parent}`, parent)).toBe(true); // named, it may still start
  });

  test("cannot be edited or sent now, in the store or through the routes", async () => {
    const parent = idleTask();
    const id = `mreport${parent}`;
    message(parent, id, "subtask");
    expect(updateQueuedTaskMessage(id, parent, "rewritten")).toBeNull();
    expect(releaseTaskMessageHold(id, parent)).toBeNull();
    const path = `/api/tasks/${parent}/messages/${id}`;
    const patch = await taskMessageRoute(new Request(`http://wisp.test${path}`, { method: "PATCH", body: JSON.stringify({ message: "x" }) }), path, "PATCH")!;
    expect({ status: patch.status, body: await patch.json() }).toEqual({
      status: 409, body: { error: "a subtask report is delivered by Wisp: it cannot be edited or sent now, only cancelled" },
    });
    const compacts = { isCompacting: () => false } as unknown as TaskCompactor;
    const sendNow = await taskMessageSendNowRoute(new Request(`http://wisp.test${path}/send-now`, { method: "POST" }), `${path}/send-now`, "POST",
      {} as WispConfig, {} as Record<string, AdapterDef>, compacts)!;
    expect(sendNow.status).toBe(409);
    // cancelling stays possible
    const cancelled = await taskMessageRoute(new Request(`http://wisp.test${path}`, { method: "DELETE" }), path, "DELETE")!;
    expect(cancelled.status).toBe(200);
  });

  test("keeps autopilot from calling its parent idle, while the parent can still take it", () => {
    const parent = idleTask();
    expect(taskIsIdle(getTask(parent)!)).toBe(true);
    message(parent, `mreport${parent}`, "subtask");
    expect(taskIsIdle(getTask(parent)!)).toBe(false);
    expect(canTakeReport(getTask(parent)!)).toBe(true);
    transition(parent, "needs-input");
    expect(canTakeReport(getTask(parent)!)).toBe(false);
    // a report recorded but not yet queued counts too
    const other = idleTask();
    db.run(`INSERT INTO subtask_reports (id, child_task_id, parent_task_id, kind, event_key, facts_json, state, created_at, updated_at)
      VALUES (?, 'tkidq', ?, 'turn', 'turn:1', '{"kind":"turn"}', 'pending', 'x', 'x')`, [`srq${other}`, other]);
    expect(taskIsIdle(getTask(other)!)).toBe(false);
    expect(taskIsIdle(getTask(other)!, "ignore")).toBe(true);
  });
});
