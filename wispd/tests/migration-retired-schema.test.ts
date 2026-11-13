// Migration 33: an older profile loses the schema of a removed feature, and a
// fresh one never had it.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../src/migrations";

const TABLES = ["task_briefs", "brief_runs", "task_answer_observations"];
const COLUMNS = ["brief_enabled", "brief_generation", "input_rev"];

function profile(label: string): Database {
  const dir = mkdtempSync(join(tmpdir(), `wisp-migrate-${label}-`));
  return new Database(join(dir, "wisp.db"), { create: true });
}

/** Schema 32, with what migrations 14 and 15 used to leave in it. */
function olderProfile(): Database {
  const db = profile("retired-older");
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id).filter((m) => m.id <= 32)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'then')").run(migration.id, migration.name);
  }
  for (const column of COLUMNS) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  for (const table of TABLES) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE)`);
    db.exec(`CREATE INDEX idx_${table}_task ON ${table}(task_id)`);
  }
  return db;
}

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[]).map((r) => r.name);
const taskColumns = (db: Database) =>
  (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);

describe("migration 33: the retired schema", () => {
  test("an older profile drops the tables and columns and keeps its tasks", () => {
    const db = olderProfile();
    db.query("INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at) VALUES ('tkeep', 'kept', '/fixture', 'fake', 'done', 'now', 'now')").run();
    for (const table of TABLES) db.query(`INSERT INTO ${table} (id, task_id) VALUES ('row', 'tkeep')`).run();

    // 33 and whatever came after it
    expect(migrate(db).applied).toEqual(MIGRATIONS.map((m) => m.id).filter((id) => id >= 33).sort((a, b) => a - b));
    for (const table of TABLES) {
      expect(tables(db)).not.toContain(table);
      expect(tables(db)).not.toContain(`idx_${table}_task`);
    }
    for (const column of COLUMNS) expect(taskColumns(db)).not.toContain(column);
    expect(db.query("SELECT id, title FROM tasks").all()).toEqual([{ id: "tkeep", title: "kept" }]);
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });

  test("a fresh profile never creates them", () => {
    const db = profile("retired-fresh");
    migrate(db);
    for (const table of TABLES) expect(tables(db)).not.toContain(table);
    for (const column of COLUMNS) expect(taskColumns(db)).not.toContain(column);
    db.close();
  });
});
