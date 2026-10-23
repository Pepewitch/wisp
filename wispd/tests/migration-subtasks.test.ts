// Migration 26 (subtasks), applied to a profile the release before it left
// behind: the backfill of existing reviewers, and every trigger.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/migrations";

/** A profile at schema 25, the way 0.7.1 leaves one. */
function v25Profile(): Database {
  const dir = mkdtempSync(join(tmpdir(), "wisp-migrate-subtasks-"));
  const db = new Database(join(dir, "wisp.db"), { create: true });
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => m.id <= 25)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'then')").run(migration.id, migration.name);
  }
  return db;
}

const STAMP = "2026-01-01T00:00:00.000Z";

function task(db: Database, id: string, extra: { verify_role?: string; archived?: number } = {}): void {
  db.query(`INSERT INTO tasks (id, title, repo_path, harness, state, verify_role, archived, created_at, updated_at)
    VALUES (?, ?, '/fixture', 'fake', 'done', ?, ?, ?, ?)`).run(id, id, extra.verify_role ?? null, extra.archived ?? 0, STAMP, STAMP);
}

function round(db: Database, id: string, author: string, legacyReviewer: string | null = null): void {
  db.query(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, round, token, state, reviewer_task_id, created_at)
    VALUES (?, ?, 'wfixture', 7, 'abc', 1, 'tok', 'pass', ?, ?)`).run(id, author, legacyReviewer, STAMP);
}

function review(db: Database, id: string, roundId: string, reviewer: string, role = "primary"): void {
  db.query(`INSERT INTO round_reviews (id, round_id, role, reviewer_task_id, token, state, created_at)
    VALUES (?, ?, ?, ?, 'tok', 'pass', ?)`).run(id, roundId, role, reviewer, STAMP);
}

const row = (db: Database, id: string) =>
  db.query("SELECT parent_task_id, subtask_kind, report_to_parent, base_from, merge_granted_by, updated_at FROM tasks WHERE id = ?").get(id);

describe("migration 26: subtasks", () => {
  test("a schema-25 profile gains the columns and the reports table, and only 26 runs", () => {
    const db = v25Profile();
    task(db, "troot");
    expect(migrate(db).applied).toEqual([26]);
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("tasks")).toEqual(expect.arrayContaining(["parent_task_id", "subtask_kind", "report_to_parent", "base_from", "merge_granted_by"]));
    expect(columns("turns")).toContain("source_message_id");
    expect(columns("task_messages")).toContain("actor");
    expect(columns("workflows")).toContain("merge_allowed_by");
    expect(columns("subtask_reports")).toContain("event_key");
    // existing rows: a root, reporting off, and no provenance, which confers no merge rights
    expect(row(db, "troot")).toEqual({ parent_task_id: null, subtask_kind: null, report_to_parent: 0, base_from: null, merge_granted_by: null, updated_at: STAMP });
    expect(migrate(db).applied).toEqual([]);
  });

  test("existing reviewers, live and archived, become review subtasks of their author; a missing author leaves one top-level", () => {
    const db = v25Profile();
    task(db, "tauthor");
    task(db, "tlive", { verify_role: "reviewer" });
    task(db, "tgone", { verify_role: "reviewer", archived: 1 });
    task(db, "tlegacy", { verify_role: "reviewer", archived: 1 });
    task(db, "tlost", { verify_role: "reviewer", archived: 1 });
    task(db, "trecipe", { verify_role: "recipe" });
    round(db, "r1", "tauthor");
    review(db, "v1", "r1", "tlive");
    // carried across rounds: the same reviewer named by a second round of the same author
    round(db, "r2", "tauthor");
    review(db, "v2", "r2", "tgone");
    review(db, "v3", "r2", "tlive", "second");
    // before review panels the round itself named its reviewer
    round(db, "r3", "tauthor", "tlegacy");
    // an author already purged
    round(db, "r4", "tpurged");
    review(db, "v4", "r4", "tlost");
    migrate(db);
    for (const id of ["tlive", "tgone", "tlegacy"]) expect(row(db, id)).toMatchObject({ parent_task_id: "tauthor", subtask_kind: "review", report_to_parent: 0, updated_at: STAMP });
    expect(row(db, "tlost")).toMatchObject({ parent_task_id: null, subtask_kind: null });
    expect(row(db, "trecipe")).toMatchObject({ parent_task_id: null, subtask_kind: null });
    expect(row(db, "tauthor")).toMatchObject({ parent_task_id: null, updated_at: STAMP });
  });

  test("deleting a parent unlinks its children and drops its undelivered reports; a child's own reports go with it", () => {
    const db = v25Profile();
    migrate(db);
    for (const id of ["tparent", "tchild", "tother"]) task(db, id);
    db.run("UPDATE tasks SET parent_task_id = 'tparent', subtask_kind = 'explore' WHERE id = 'tchild'");
    const report = (id: string, child: string, parent: string, state: string) => db.query(`INSERT INTO subtask_reports
      (id, child_task_id, parent_task_id, kind, event_key, facts_json, state, created_at, updated_at) VALUES (?, ?, ?, 'turn', ?, '{}', ?, ?, ?)`)
      .run(id, child, parent, `turn:${id}`, state, STAMP, STAMP);
    report("p1", "tchild", "tparent", "pending");
    report("p2", "tchild", "tparent", "delivered");
    report("p3", "tother", "tchild", "pending");
    db.run("DELETE FROM tasks WHERE id = 'tparent'");
    expect(row(db, "tchild")).toMatchObject({ parent_task_id: null, subtask_kind: "explore", updated_at: STAMP });
    expect(db.query("SELECT id, state, reason FROM subtask_reports ORDER BY id").all()).toEqual([
      { id: "p1", state: "dropped", reason: "parent deleted" },
      { id: "p2", state: "delivered", reason: null },
      { id: "p3", state: "pending", reason: null },
    ]);
    db.run("DELETE FROM tasks WHERE id = 'tother'");
    expect(db.query("SELECT id FROM subtask_reports ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p2" }]);
  });

  test("a report is delivered when its message starts a turn, dropped when it is cancelled or its parent archived", () => {
    const db = v25Profile();
    migrate(db);
    for (const id of ["tparent", "tchild"]) task(db, id);
    const message = (id: string) => db.query(`INSERT INTO task_messages (id, task_id, text, status, attachment_hash, origin, created_at, updated_at)
      VALUES (?, 'tparent', 'reports', 'queued', '', 'subtask', ?, ?)`).run(id, STAMP, STAMP);
    const report = (id: string, state: string, messageId: string | null) => db.query(`INSERT INTO subtask_reports
      (id, child_task_id, parent_task_id, kind, event_key, facts_json, state, message_id, created_at, updated_at)
      VALUES (?, 'tchild', 'tparent', 'turn', ?, '{}', ?, ?, ?, ?)`).run(id, `turn:${id}`, state, messageId, STAMP, STAMP);
    message("ms1");
    message("ms2");
    message("ms3");
    report("q1", "queued", "ms1");
    report("q2", "queued", "ms2");
    report("q3", "queued", "ms3");
    report("q4", "pending", null);
    db.run("UPDATE task_messages SET status = 'delivered', delivery = 'started', turn_n = 1 WHERE id = 'ms1'");
    db.run("UPDATE task_messages SET status = 'cancelled' WHERE id = 'ms2'");
    db.run("UPDATE tasks SET archived = 1 WHERE id = 'tparent'");
    const state = (id: string) => db.query("SELECT state, reason FROM subtask_reports WHERE id = ?").get(id);
    expect(state("q1")).toEqual({ state: "delivered", reason: null });
    expect(state("q2")).toEqual({ state: "dropped", reason: "cancelled" });
    expect(db.query("SELECT status FROM task_messages WHERE id = 'ms3'").get()).toEqual({ status: "cancelled" });
    expect(state("q3")).toEqual({ state: "dropped", reason: "cancelled" });
    expect(state("q4")).toEqual({ state: "dropped", reason: "parent archived" });
  });
});
