// Migration 29 (review-now), applied to a profile 0.8.2 leaves behind: every
// existing round waited for its checks, so it reads early = 0.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/migrations";

const AT = "2026-10-01T00:00:00.000Z";

test("a schema-28 profile gains auto_review_rounds.early, 0 on its rounds, and only 29 runs", () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "wisp-migrate-review-now-")), "wisp.db"), { create: true });
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => m.id <= 28)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'then')").run(migration.id, migration.name);
  }
  db.run(`INSERT INTO auto_review_rounds (id, task_id, workflow_id, pr, head, round, token, state, created_at)
    VALUES ('rd1', 'told', 'wpilot', 12, 'abc', 1, 'tok', 'pass', ?)`, [AT]);

  expect(migrate(db).applied).toEqual([29]);
  expect(db.query("SELECT id, early FROM auto_review_rounds").all()).toEqual([{ id: "rd1", early: 0 }]);
  expect(migrate(db).applied).toEqual([]);
});
