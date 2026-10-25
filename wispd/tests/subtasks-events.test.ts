// A reporting subtask's PR events, recorded with the autopilot change that
// caused them and once each: a settled review round, a merge, a close, and
// autopilot needing a person, which the parent hears as a fixed class only.
import { describe, expect, test } from "bun:test";
import { finishAutopilot, pauseAutopilot, rebindAfterMerge, saveAutopilotCheck } from "../src/autopilot/store";
import { createTask, db, freeSlot, newTaskId, randomId, setTaskFields, transition } from "../src/store";
import { reportFraming } from "../src/subtask-reports";
import { settleRound } from "../src/verify/reviews";
import { getWorkflow, type WorkflowRow } from "../src/workflows/store";

function child(report = true): { child: string; parent: string; row: () => WorkflowRow } {
  const parent = newTaskId();
  createTask({ id: parent, title: "parent", repo_path: "/fixture", harness: "fake", model: null, slot: freeSlot() });
  const id = newTaskId();
  createTask({
    id, title: "child", repo_path: "/fixture", harness: "fake", model: null, slot: freeSlot(),
    subtask: { parent_task_id: parent, subtask_kind: "explore", report_to_parent: report, base_from: "project" },
  });
  setTaskFields(id, { worktree_path: "/fixture", branch: `wisp/${id}` });
  transition(id, "done");
  const workflow = `w${id}`;
  db.run(`INSERT INTO workflows (id, task_id, type, version, params_json, checkpoint_json, state, reason, context_n, next_check_at, expires_at, created_at, updated_at)
    VALUES (?, ?, 'pr-autopilot', '1', '{"autoMerge":true,"autoReview":true}', ?, 'active', 'watching', 1, 'x', '9999', 'x', 'x')`,
  [workflow, id, JSON.stringify({ pr: 12, heads: { aaa111: "2026-01-01", bbb222: "2026-01-02" } })]);
  return { child: id, parent, row: () => getWorkflow(workflow)! };
}

const events = (id: string) => (db.query("SELECT event_key, facts_json FROM subtask_reports WHERE child_task_id = ? ORDER BY rowid").all(id) as
  { event_key: string; facts_json: string }[]).map((row) => [row.event_key, JSON.parse(row.facts_json)]);

function settledRound(taskId: string, workflowId: string): string {
  const round = randomId("r", 10);
  db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, round, token, state, created_at) VALUES (?, ?, ?, 12, 'bbb222', 2, 'tok', 'running', 'x')`,
    [round, taskId, workflowId]);
  db.run(`INSERT INTO round_reviews (id, round_id, role, token, state, created_at) VALUES (?, ?, 'primary', 'tok', 'fail', 'x')`, [randomId("v", 10), round]);
  return round;
}

describe("a reporting subtask's PR events", () => {
  test("a settled round, once, with its outcome and never its findings", () => {
    const { child: id, row } = child();
    const round = settledRound(id, row().id);
    settleRound(round);
    settleRound(round);
    expect(events(id)).toEqual([[`round:${round}`, { kind: "round", pr: 12, head: "bbb222", round: 2, outcome: "inconclusive" }]]);
  });

  test("a merge and a close, each once per PR and head", () => {
    const { child: id, row } = child();
    rebindAfterMerge(row(), { pr: 12, base: "main", byWisp: true }, new Date(), "bbb222");
    rebindAfterMerge(row(), { pr: 12, base: "main", byWisp: true }, new Date(), "bbb222");
    db.run("UPDATE workflows SET checkpoint_json = ? WHERE id = ?", [JSON.stringify({ pr: 13, heads: { ccc333: "2026-01-03" } }), row().id]);
    finishAutopilot(row(), "closed", "PR #13 was closed", new Date());
    expect(events(id)).toEqual([
      ["merged:12:bbb222", { kind: "merged", pr: 12, head: "bbb222" }],
      ["closed:13:ccc333", { kind: "closed", pr: 13, head: "ccc333" }],
    ]);
  });

  test("autopilot needing a person reports its class once per class; a pause too; the reason text never travels", () => {
    const { child: id, row } = child();
    const save = (reason: string) => saveAutopilotCheck(row(), { state: "needs-you", reason, checkpoint: { pr: 12, heads: { bbb222: "x" } }, delayMs: 60_000 }, new Date());
    save("The PR has a merge conflict with main");
    save("The PR has a merge conflict with main");
    save("Waiting for checks");
    pauseAutopilot(row(), "Merge failed: gh: GraphQL: secret-looking output ghp_notreal", new Date());
    expect(events(id).map(([key, facts]) => [key, facts.class])).toEqual([
      ["hold:12:bbb222:conflict", "conflict"],
      ["hold:12:bbb222:needs-you", "needs-you"],
      ["hold:12:bbb222:merge-failed", "merge-failed"],
    ]);
    db.run("UPDATE subtask_reports SET message_id = 'msholds' WHERE child_task_id = ?", [id]);
    const framed = reportFraming("msholds");
    expect(framed.lines.join("\n")).toContain("PR #12 needs a decision (merge-failed)");
    expect(framed.lines.join("\n")).not.toContain("ghp_notreal");
    expect(framed.words).toBe("");
  });

  test("a child that does not report records nothing", () => {
    const { child: id, row } = child(false);
    rebindAfterMerge(row(), { pr: 12, base: "main", byWisp: true }, new Date(), "bbb222");
    pauseAutopilot(row(), "Auto-fix gave up after 3 rounds — resume to try again", new Date());
    expect(events(id)).toEqual([]);
  });
});
