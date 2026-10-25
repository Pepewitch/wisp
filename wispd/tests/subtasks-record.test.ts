// What a reporting subtask records for its parent, and when: written with the
// settlement it reports, once per (child, event), and never for a turn the
// parent or autopilot started, an interrupted turn or a background follow-up.
import { describe, expect, test } from "bun:test";
import { setAutopilot, autopilotRow } from "../src/autopilot/store";
import {
  createTask, createTaskMessage, createTurn, db, freeSlot, newTaskId, setTaskFields, settleTurn, transition,
} from "../src/store";
import { failStaleCreatingTasks } from "../src/runner";
import { recordPrEvent, recordSetupFailure, recordStuckReport, recordTurnReport } from "../src/subtask-reports";

function task(extra: { parent?: string; report?: boolean } = {}): string {
  const id = newTaskId();
  createTask({
    id, title: extra.parent ? "child" : "parent", repo_path: "/fixture", harness: "fake", model: null, mode: "worktree", slot: freeSlot(),
    ...(extra.parent ? { subtask: { parent_task_id: extra.parent, subtask_kind: "explore" as const, report_to_parent: extra.report !== false, base_from: "project" } } : {}),
  });
  setTaskFields(id, { worktree_path: "/fixture", branch: `wisp/${id}` });
  transition(id, "running");
  return id;
}

let turns = 0;
/** A turn of `taskId`, settled as asked; `from` is the message that started it, with its sender. */
function settle(taskId: string, status: "done" | "failed" | "interrupted", options: {
  state?: string; from?: { actor?: string; workflow?: string }; origin?: "background"; result?: string;
} = {}): number {
  const n = ++turns;
  let source: string | null = null;
  if (options.from) {
    source = `mrec${taskId}${n}`;
    createTaskMessage({ id: source, taskId, text: "go", attachmentHash: "", actor: options.from.actor ?? null }, false);
    if (options.from.workflow) db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [options.from.workflow, source]);
  }
  const id = createTurn(taskId, n, "go", null, "/fixture/log", null, null, null, undefined, options.origin ?? null, source);
  settleTurn(id, { status, exitCode: 0, result: options.result ?? `answer ${n}` }, taskId, (options.state ?? (status === "interrupted" ? "needs-input" : status)) as "done", null);
  return id;
}

const reports = (child: string) =>
  db.query("SELECT event_key, kind, facts_json, body, state, reason FROM subtask_reports WHERE child_task_id = ? ORDER BY rowid").all(child) as
    { event_key: string; kind: string; facts_json: string; body: string | null; state: string; reason: string | null }[];

describe("a setup that never finished", () => {
  test("a reporting child the daemon died creating reports setup-failed when startup fails it", () => {
    const parent = task();
    const id = newTaskId();
    createTask({
      id, title: "child", repo_path: "/fixture", harness: "fake", model: null, mode: "worktree", slot: freeSlot(),
      subtask: { parent_task_id: parent, subtask_kind: "explore", report_to_parent: true, base_from: "project" },
    });
    failStaleCreatingTasks();
    expect(reports(id)).toEqual([expect.objectContaining({ event_key: "setup-failed", kind: "setup-failed", state: "pending" })]);
  });
});

describe("recording what a subtask reports", () => {
  test("a done, a needs-input and a failed turn report, each once, with the turn's own words", () => {
    const parent = task();
    const child = task({ parent });
    const first = settle(child, "done", { result: "found it" });
    settle(child, "done", { state: "needs-input", from: { actor: "web" } });
    settle(child, "failed");
    const rows = reports(child);
    expect(rows.map((row) => [row.kind, JSON.parse(row.facts_json).outcome, row.state])).toEqual([
      ["turn", "done", "pending"], ["turn", "needs input", "pending"], ["turn", "failed", "pending"],
    ]);
    expect(rows[0]!.body).toBe("found it");
    // recording the same settlement again (recovery after a restart) changes nothing
    recordTurnReport(first, "done");
    expect(reports(child)).toHaveLength(3);
  });

  test("nothing from a child without reporting, an interrupted turn, a background follow-up, or a turn its parent or autopilot started", () => {
    const parent = task();
    const quiet = task({ parent, report: false });
    settle(quiet, "done");
    expect(reports(quiet)).toEqual([]);
    const child = task({ parent });
    settle(child, "interrupted");
    settle(child, "done", { origin: "background" });
    settle(child, "done", { from: { actor: `agent:${parent}` } });
    setAutopilot(parent, { autoFix: true });
    settle(child, "done", { from: { workflow: autopilotRow(parent)!.id } });
    expect(reports(child)).toEqual([]);
    // another agent's message, or a person's, still reports
    settle(child, "done", { from: { actor: "agent:tsomeone" } });
    expect(reports(child)).toHaveLength(1);
  });

  test("stuck reports once per turn; setup failure and PR events record their facts; an archived parent drops the row", () => {
    const parent = task();
    const child = task({ parent });
    recordStuckReport(child, 4);
    recordStuckReport(child, 4);
    recordSetupFailure(child, "git worktree add failed: no such base");
    recordPrEvent(child, "merged:12:abc", { kind: "merged", pr: 12, head: "abc" });
    expect(reports(child).map((row) => [row.event_key, row.body])).toEqual([
      ["stuck:4", null], ["setup-failed", "git worktree add failed: no such base"], ["merged:12:abc", null],
    ]);
    setTaskFields(parent, { archived: 1 });
    recordPrEvent(child, "closed:12:abc", { kind: "closed", pr: 12, head: "abc" });
    expect(reports(child).at(-1)).toMatchObject({ event_key: "closed:12:abc", state: "dropped", reason: "parent archived" });
  });
});
