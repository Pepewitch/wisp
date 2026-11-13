// A parent marking a subtask's waiting reports as handled (#527): only `done`
// turn reports through the turn it read, never anything actionable, with the
// audit kept and a queued message that loses everything cancelled.
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli-args";
import { parseReport, reportAckLine, REPORT_USAGE } from "../src/cli-report";
import type { WispConfig } from "../src/config";
import { route } from "../src/routes";
import { createTask, createTaskMessage, createTurn, db, freeSlot, getTaskMessage, newTaskId } from "../src/store";
import { ackReports, HANDLED_REASON } from "../src/subtask-report-ack";
import { reportFraming } from "../src/subtask-reports";
import { testRouteContext } from "./helpers/daemon-context";

function family(): { parent: string; child: string } {
  const parent = newTaskId();
  createTask({ id: parent, title: "parent", repo_path: "/fixture", harness: "quick", model: null, slot: freeSlot() });
  const child = newTaskId();
  createTask({
    id: child, title: "child", repo_path: "/fixture", harness: "quick", model: null, slot: freeSlot(),
    subtask: { parent_task_id: parent, subtask_kind: "explore", report_to_parent: true, base_from: "main" },
  });
  return { parent, child };
}

function turn(child: string, n: number, status: "done" | "failed"): void {
  const id = createTurn(child, n, "work", null, "/dev/null");
  db.run("UPDATE turns SET status = ? WHERE id = ?", [status, id]);
}

let seq = 0;
function report(
  parent: string,
  child: string,
  facts: Record<string, unknown>,
  state: "pending" | "queued" = "pending",
  messageId: string | null = null,
): string {
  const id = `srack${++seq}x${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date(Date.UTC(2026, 10, 4, 0, 0, seq)).toISOString();
  db.run(`INSERT INTO subtask_reports (id, child_task_id, parent_task_id, kind, event_key, facts_json, body, state, message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, child, parent, facts.kind as string, `${facts.kind}:${seq}`, JSON.stringify(facts), `words ${seq}`, state, messageId, at, at]);
  return id;
}

const row = (id: string) => db.query("SELECT state, reason FROM subtask_reports WHERE id = ?").get(id) as { state: string; reason: string | null };

describe("marking a subtask's reports handled", () => {
  test("drops waiting done-turn reports through the turn read, and keeps every actionable one", () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    turn(child, 2, "failed");
    turn(child, 3, "done");
    const done1 = report(parent, child, { kind: "turn", turn: 1, outcome: "done" });
    const failed2 = report(parent, child, { kind: "turn", turn: 2, outcome: "failed" });
    const asks = report(parent, child, { kind: "turn", turn: 3, outcome: "needs input" });
    const question = report(parent, child, { kind: "question", turn: 3, questionId: "q1" });
    const hold = report(parent, child, { kind: "needs-you", pr: 4, class: "conflict" });
    const done3 = report(parent, child, { kind: "turn", turn: 3, outcome: "done" });

    expect(ackReports(child, 3)).toEqual({ through: 3, handled: 2, kept: 4, cancelled: [] });
    for (const id of [done1, done3]) expect(row(id)).toEqual({ state: "dropped", reason: HANDLED_REASON });
    for (const id of [failed2, asks, question, hold]) expect(row(id).state).toBe("pending");
  });

  test("stops at the turn the parent read, and a turn past the latest finished one is capped to it", () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    turn(child, 2, "done");
    const first = report(parent, child, { kind: "turn", turn: 1, outcome: "done" });
    const second = report(parent, child, { kind: "turn", turn: 2, outcome: "done" });
    expect(ackReports(child, 1)).toMatchObject({ through: 1, handled: 1, kept: 1 });
    expect(row(first).state).toBe("dropped");
    expect(row(second).state).toBe("pending");
    expect(ackReports(child, 99)).toMatchObject({ through: 2, handled: 1, kept: 0 });
    expect(row(second).state).toBe("dropped");
  });

  test("a child with no finished turn has nothing to mark", () => {
    const { parent, child } = family();
    const stuck = report(parent, child, { kind: "stuck", turn: 1 });
    expect(ackReports(child, 1)).toEqual({ through: null, handled: 0, kept: 1, cancelled: [] });
    expect(row(stuck).state).toBe("pending");
  });

  test("a queued message left empty is cancelled; one that keeps a report delivers only that one", () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    turn(child, 2, "failed");
    const emptied = `msack${++seq}`;
    createTaskMessage({ id: emptied, taskId: parent, text: "1 report from your subtasks.", attachmentHash: "", origin: "subtask", actor: "system" });
    report(parent, child, { kind: "turn", turn: 1, outcome: "done" }, "queued", emptied);
    const mixed = `msack${++seq}`;
    createTaskMessage({ id: mixed, taskId: parent, text: "2 reports from your subtasks.", attachmentHash: "", origin: "subtask", actor: "system" });
    report(parent, child, { kind: "turn", turn: 1, outcome: "done" }, "queued", mixed);
    const failed = report(parent, child, { kind: "turn", turn: 2, outcome: "failed" }, "queued", mixed);

    const ack = ackReports(child, 2);
    expect(ack).toMatchObject({ through: 2, handled: 2, kept: 1, cancelled: [emptied] });
    expect(getTaskMessage(emptied)!.status).toBe("cancelled");
    expect(getTaskMessage(mixed)!.status).toBe("queued");
    expect(row(failed).state).toBe("queued");
    const framed = reportFraming(mixed);
    expect(framed.lines[0]).toStartWith("1 report from your subtasks");
    expect(framed.lines[1]).toContain("finished turn 2: failed");
    expect(getTaskMessage(mixed)!.text).toStartWith("1 report from your subtasks");
  });

  test("a message a turn is already starting, steering or has delivered keeps its reports", () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    const ids = ["started", "steered", null].map((claim) => {
      const message = `msack${++seq}`;
      createTaskMessage({ id: message, taskId: parent, text: "1 report", attachmentHash: "", origin: "subtask", actor: "system" });
      if (claim) db.run("UPDATE task_messages SET claim = ? WHERE id = ?", [claim, message]);
      else db.run("UPDATE task_messages SET status = 'delivered' WHERE id = ?", [message]);
      return report(parent, child, { kind: "turn", turn: 1, outcome: "done" }, "queued", message);
    });
    expect(ackReports(child, 1)).toMatchObject({ handled: 0, kept: 3, cancelled: [] });
    for (const id of ids) expect(row(id).state).toBe("queued");
  });
});

describe("POST /api/tasks/:id/report-ack", () => {
  const cfg = { token: "t", repos: [], harnessDefaults: {} } as unknown as WispConfig;
  const call = (id: string, body: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1/api/tasks/${id}/report-ack`);
    const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers });
    return route(req, url, url.pathname, testRouteContext(cfg, {}));
  };

  test("answers the ack and records it on the parent, as the agent that asked", async () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    report(parent, child, { kind: "turn", turn: 1, outcome: "done" });
    const res = await call(child, { throughTurn: 1 }, { "x-wisp-client": "cli", "x-wisp-task": parent });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ through: 1, handled: 1, kept: 0, cancelled: [] });
    const audit = db.query("SELECT action, actor, detail FROM task_audit WHERE task_id = ? AND action = 'report-ack'").get(parent);
    expect(audit).toEqual({ action: "report-ack", actor: `agent:${parent}`, detail: `${child} through turn 1: 1 handled` });
  });

  test("a person may ack too; the child itself and a sibling may not", async () => {
    const { parent, child } = family();
    turn(child, 1, "done");
    const id = report(parent, child, { kind: "turn", turn: 1, outcome: "done" });
    const self = await call(child, { throughTurn: 1 }, { "x-wisp-client": "cli", "x-wisp-task": child });
    expect(self.status).toBe(403);
    expect(((await self.json()) as { error: string }).error).toContain(`only the parent task (${parent})`);
    expect((await call(child, { throughTurn: 1 }, { "x-wisp-client": "cli", "x-wisp-task": "tsibling" })).status).toBe(403);
    expect(row(id).state).toBe("pending");
    const person = await call(child, { throughTurn: 1 }, { "x-wisp-client": "web" });
    expect(await person.json()).toMatchObject({ handled: 1 });
  });

  test("refuses a missing or bad turn number and a task that is not a subtask", async () => {
    const { parent, child } = family();
    expect((await call(child, {})).status).toBe(400);
    expect((await call(child, { throughTurn: 0 })).status).toBe(400);
    expect((await call(child, { throughTurn: "2" })).status).toBe(400);
    const root = await call(parent, { throughTurn: 1 });
    expect(root.status).toBe(409);
    expect(((await root.json()) as { error: string }).error).toContain("not a subtask");
  });
});

describe("wisp report ack", () => {
  test("parses the subtask and the turn it read, which it requires", () => {
    expect(parseReport(["ack", "tkid"], {})).toContain("--through-turn <n> is required");
    expect(parseReport(["ack", "tkid"], { "through-turn": "3" })).toEqual({ child: "tkid", throughTurn: 3 });
    expect(parseReport(["ack", "tkid"], { "through-turn": "0" })).toContain("--through-turn must be a turn number");
    expect(parseReport(["ack"], {})).toBe(REPORT_USAGE);
    expect(parseReport(["drop", "tkid"], {})).toBe(REPORT_USAGE);
  });

  test("reads the turn from the command line as typed, not as a stray argument", () => {
    // the words after `wisp report`, as the CLI hands them to the parser
    const { positional, flags } = parseArgs(["ack", "tkid", "--through-turn", "1"]);
    expect(parseReport(positional, flags)).toEqual({ child: "tkid", throughTurn: 1 });
    const json = parseArgs(["ack", "tkid", "--through-turn", "2", "--json"]);
    expect(parseReport(json.positional, json.flags)).toEqual({ child: "tkid", throughTurn: 2 });
  });

  test("says what it marked and what still waits", () => {
    expect(reportAckLine("tkid", { through: 3, handled: 2, kept: 1, cancelled: [] })).toBe(
      "2 reports from tkid through turn 3 marked handled; 1 still waiting (failures, questions, PR events, later turns and reports already being delivered stay)",
    );
    expect(reportAckLine("tkid", { through: 3, handled: 0, kept: 0, cancelled: [] })).toBe("no waiting report from tkid through turn 3 to mark handled");
    expect(reportAckLine("tkid", { through: null, handled: 0, kept: 0, cancelled: [] })).toBe("tkid has no finished turn yet; nothing to mark handled");
  });
});
