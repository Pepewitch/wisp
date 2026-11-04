/**
 * Bounded report batches and superseded turn reports (#519): a parent busy
 * while many reports arrive gets them in ordered batches of bounded size, and
 * a turn report the child has since moved past says so instead of passing an
 * old state off as current.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOG_DIR } from "../src/config";
import { apiTaskMessage } from "../src/routes/http";
import { createTask, createTaskMessage, createTurn, db, freeSlot, getTaskMessage, newTaskId, settleTurn } from "../src/store";
import { subscribe } from "../src/events";
import { queueReports, refreshReportText, REPORT_BATCH_MAX_CHARS, REPORT_BATCH_MAX_REPORTS } from "../src/subtask-report-queue";
import { reportFraming } from "../src/subtask-reports";

function task(parent?: string): string {
  const id = newTaskId();
  createTask({ id, title: "batch test", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  if (parent) db.run("UPDATE tasks SET parent_task_id = ?, report_to_parent = 1 WHERE id = ?", [parent, id]);
  return id;
}

let seq = 0;
/** A pending report row, as subtask-reports.ts records one. */
function report(child: string, parent: string, facts: Record<string, unknown>, body: string | null): void {
  seq += 1;
  const at = new Date(Date.UTC(2026, 10, 4, 0, 0, seq)).toISOString();
  db.run(`INSERT INTO subtask_reports (id, child_task_id, parent_task_id, kind, event_key, facts_json, body, state, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`, [`srb${seq}`, child, parent, facts.kind as string, `k${seq}`, JSON.stringify(facts), body, at, at]);
}

/** A settled turn of the child. */
function turn(child: string, n: number, status: "done" | "interrupted" = "done", origin: string | null = null): void {
  const id = createTurn(child, n, "work", null, join(LOG_DIR, `${child}-${n}.log`), null);
  if (origin) db.run("UPDATE turns SET origin = ? WHERE id = ?", [origin, id]);
  settleTurn(id, { status, exitCode: status === "done" ? 0 : null, result: status === "done" ? `turn ${n}` : null }, child, "done", null);
}

const states = (parent: string) => db.query("SELECT state, message_id FROM subtask_reports WHERE parent_task_id = ? ORDER BY created_at, rowid").all(parent) as { state: string; message_id: string | null }[];

describe("report batches", () => {
  test("hold at most ten reports, oldest first; the rest wait in order for the next message", () => {
    const parent = task(), child = task(parent);
    for (let i = 1; i <= REPORT_BATCH_MAX_REPORTS + 3; i++) report(child, parent, { kind: "closed", pr: i, head: "abc" }, null);
    const first = queueReports({ id: parent })!;
    expect(states(parent).map((row) => row.message_id === first ? "first" : row.state)).toEqual([...Array(REPORT_BATCH_MAX_REPORTS).fill("first"), "pending", "pending", "pending"]);
    expect(reportFraming(first).lines[0]).toStartWith(`${REPORT_BATCH_MAX_REPORTS} reports from your subtasks.`);
    const second = queueReports({ id: parent })!;
    expect(states(parent).slice(REPORT_BATCH_MAX_REPORTS).every((row) => row.message_id === second)).toBe(true);
  });

  test("stop before the report that would pass the size bound, but always carry one", () => {
    const parent = task(), child = task(parent);
    const words = "x".repeat(Math.floor(REPORT_BATCH_MAX_CHARS / 2) - 10);
    for (let n = 1; n <= 3; n++) report(child, parent, { kind: "turn", turn: n, outcome: "failed" }, words);
    report(child, parent, { kind: "turn", turn: 4, outcome: "failed" }, "y".repeat(REPORT_BATCH_MAX_CHARS * 2));
    const first = queueReports({ id: parent })!;
    expect(states(parent).filter((row) => row.message_id === first)).toHaveLength(2);
    const second = queueReports({ id: parent })!;
    expect(states(parent).filter((row) => row.message_id === second)).toHaveLength(1);
    // a report bigger than the bound on its own still goes, alone
    const third = queueReports({ id: parent })!;
    expect(states(parent).filter((row) => row.message_id === third)).toHaveLength(1);
    expect(queueReports({ id: parent })).toBeNull();
  });
});

describe("a turn report the child has moved past", () => {
  test("says it is superseded and leaves out the old words; a failure, a stuck turn and a PR event stay whole", () => {
    const parent = task(), child = task(parent);
    report(child, parent, { kind: "turn", turn: 1, outcome: "done" }, "the old state");
    report(child, parent, { kind: "turn", turn: 2, outcome: "failed" }, "it broke");
    report(child, parent, { kind: "stuck", turn: 2 }, null);
    report(child, parent, { kind: "merged", pr: 4, head: "abcdef1" }, null);
    report(child, parent, { kind: "turn", turn: 3, outcome: "done" }, "the current state");
    for (let n = 1; n <= 3; n++) turn(child, n);
    const id = queueReports({ id: parent })!;
    const { lines, words } = reportFraming(id);
    expect(lines[1]).toContain(`finished turn 1: done, since superseded by its turn 3. Its words are left out; `);
    expect(lines[1]).toContain(`result ${child}\` shows the current result.`);
    expect(lines[2]).toContain("finished turn 2: failed, since superseded by its turn 3. Its words are fenced below as report 2.");
    expect(lines[3]).toContain("has gone quiet in turn 2.");
    expect(lines[4]).toContain("PR #4 merged at abcdef1.");
    expect(lines[5]).toContain("finished turn 3: done. Its words are fenced below as report 5.");
    expect(words).not.toContain("the old state");
    for (const kept of ["it broke", "the current state"]) expect(words).toContain(kept);
  });

  test("a turn still running is not newer: the last finished result is never hidden", () => {
    const parent = task(), child = task(parent);
    report(child, parent, { kind: "turn", turn: 1, outcome: "done" }, "the latest finished state");
    turn(child, 1);
    createTurn(child, 2, "more work", null, join(LOG_DIR, `${child}-2.log`), null);
    const { lines, words } = reportFraming(queueReports({ id: parent })!);
    expect(lines[1]).not.toContain("superseded");
    expect(words).toContain("the latest finished state");
  });

  test("an interrupted or background turn is not newer; a turn that ended needing input keeps its words", () => {
    const parent = task(), child = task(parent);
    report(child, parent, { kind: "turn", turn: 1, outcome: "done" }, "the only finished result");
    turn(child, 1);
    turn(child, 2, "interrupted");
    turn(child, 3, "done", "background");
    const first = reportFraming(queueReports({ id: parent })!);
    expect(first.lines[1]).not.toContain("superseded");
    expect(first.words).toContain("the only finished result");

    const other = task(), kid = task(other);
    report(kid, other, { kind: "turn", turn: 1, outcome: "needs input" }, "which database?");
    turn(kid, 1);
    turn(kid, 2);
    const asked = reportFraming(queueReports({ id: other })!);
    expect(asked.lines[1]).toContain("finished turn 1: needs input, since superseded by its turn 2. Its words are fenced below");
    expect(asked.words).toContain("which database?");
  });

  test("the transcript text is rewritten when a message starts, and an open transcript hears of it; gone rows leave it alone", () => {
    const parent = task(), child = task(parent);
    report(child, parent, { kind: "turn", turn: 1, outcome: "done" }, "the old state");
    turn(child, 1);
    const id = queueReports({ id: parent })!;
    turn(child, 2);
    const heard: string[] = [];
    const stop = subscribe((event) => { if (event.type === "message") heard.push(event.messageId); });
    try {
      refreshReportText(id, reportFraming(id));
      const text = (db.query("SELECT text FROM task_messages WHERE id = ?").get(id) as { text: string }).text;
      expect(text).toContain("since superseded by its turn 2");
      expect(text).not.toContain("the old state");
      expect(heard).toEqual([id]);
      // unchanged: no second event
      refreshReportText(id, reportFraming(id));
      expect(heard).toEqual([id]);
      // the rows gone: the stored text is the only record, and stays
      db.run("DELETE FROM subtask_reports WHERE message_id = ?", [id]);
      refreshReportText(id, reportFraming(id));
      expect((db.query("SELECT text FROM task_messages WHERE id = ?").get(id) as { text: string }).text).toBe(text);
    } finally {
      stop();
    }
  });

  test("a report message says it is one over the API; a person's message does not", () => {
    const parent = task(), child = task(parent);
    report(child, parent, { kind: "closed", pr: 1, head: "abc" }, null);
    const id = queueReports({ id: parent })!;
    expect(apiTaskMessage(getTaskMessage(id)!)).toMatchObject({ id, report: true });
    createTaskMessage({ id: `mperson${parent}`, taskId: parent, text: "my own words", attachmentHash: "" });
    expect(apiTaskMessage(getTaskMessage(`mperson${parent}`)!)).not.toHaveProperty("report");
  });
});
