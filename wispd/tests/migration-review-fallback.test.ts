// Migration 27 (review-fallback), applied to a profile 0.7.2 leaves behind:
// every existing review ran on its first agent.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/migrations";

test("a schema-26 profile gains round_reviews.fallback_json, NULL on every existing review, and only 27 runs", () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "wisp-migrate-fallback-")), "wisp.db"), { create: true });
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => m.id <= 26)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'then')").run(migration.id, migration.name);
  }
  db.run(`INSERT INTO round_reviews (id, round_id, role, reviewer_task_id, harness, token, state, created_at)
    VALUES ('vold', 'rold', 'primary', 'treviewer', 'droid', 'tok', 'pass', '2026-01-01T00:00:00.000Z')`);
  expect(migrate(db).applied.filter((id) => id <= 27)).toEqual([27]);
  expect(db.query("SELECT harness, fallback_json FROM round_reviews WHERE id = 'vold'").get()).toEqual({ harness: "droid", fallback_json: null });
  expect(migrate(db).applied).toEqual([]);
});
