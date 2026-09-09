/**
 * The schema ledger (ENG-06).
 *
 * The property that matters is not "the migrations run" — the old guarded
 * `ALTER TABLE` list did that. It is that an upgrade is RECORDED, that a
 * profile from a newer Wisp is refused instead of read with columns this build
 * cannot see, and that a real user's data survives the upgrade. So the fixtures
 * here are databases in the shapes earlier releases actually left behind, with
 * rows in them, and the assertions are about the rows.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkDatabase } from "../src/doctor";
import {
  enforceForeignKeys,
  integrityProblems,
  migrate,
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
} from "../src/migrations";

function freshDatabase(label: string): Database {
  const dir = mkdtempSync(join(tmpdir(), `wisp-migrate-${label}-`));
  return new Database(join(dir, "wisp.db"), { create: true });
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
}

function ledger(db: Database): { id: number; name: string }[] {
  return db.query("SELECT id, name FROM schema_migrations ORDER BY id").all() as { id: number; name: string }[];
}

describe("the ledger", () => {
  test("a fresh profile gets every migration, recorded once", () => {
    const db = freshDatabase("fresh");
    const first = migrate(db);
    expect(first.version).toBe(SCHEMA_VERSION);
    expect(first.applied).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(ledger(db).map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));

    // The whole point of a ledger: the second run does nothing.
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(ledger(db)).toHaveLength(MIGRATIONS.length);
    db.close();
  });

  test("upgrading preserves older turns and seeds their process identity conservatively", () => {
    const db = freshDatabase("background-upgrade");
    migrate(db);
    db.exec("DROP TABLE turn_process_groups; DELETE FROM schema_migrations WHERE id = 3");
    db.query("INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at) VALUES ('tfixture', 'fixture', '/fixture', 'fake', 'done', 'now', 'now')").run();
    db.query("INSERT INTO turns (task_id, n, prompt, result, status, pid, pid_start_time, log_file, started_at) VALUES ('tfixture', 1, 'work', 'kept result', 'done', 12345, 'old-start', '/fixture/log', 'now')").run();
    expect(migrate(db).applied).toEqual([3]);
    expect(db.query("SELECT pgid, boot_id, members_json, state FROM turn_process_groups").get()).toEqual({
      pgid: 12345, boot_id: null, members_json: '[{"pid":12345,"started":"old-start"}]', state: "unknown",
    });
    expect(db.query("SELECT result FROM turns").get()).toEqual({ result: "kept result" });
    db.close();
  });

  test("upgrading unfinished archives preserves jobs but pauses only the ambiguous script stage", () => {
    const db = freshDatabase("cleanup-upgrade");
    migrate(db);
    db.exec("DROP TABLE archive_cleanup_progress; DELETE FROM schema_migrations WHERE id = 4");
    for (const [id, stage] of [["tfixture1", "remove-worktree"], ["tfixture2", "remove-attachments"]]) {
      db.query(`INSERT INTO archive_cleanups (task_id, stage, force, stop_turn, removable, repo_path, archive_script, timeout_minutes, created_at, updated_at)
        VALUES (?, ?, 1, 0, 1, '/fixture', 'echo fixture', 5, 'now', 'now')`).run(id!, stage!);
    }
    expect(migrate(db).applied).toEqual([4]);
    expect(db.query("SELECT task_id, phase, status, hook_pgid FROM archive_cleanup_progress ORDER BY task_id").all()).toEqual([
      { task_id: "tfixture1", phase: "legacy-hooks", status: "needs-attention", hook_pgid: null },
      { task_id: "tfixture2", phase: "remove-attachments", status: "pending", hook_pgid: null },
    ]);
    expect(db.query("SELECT archive_script FROM archive_cleanups").all()).toEqual([{ archive_script: "echo fixture" }, { archive_script: "echo fixture" }]);
    expect(migrate(db).applied).toEqual([]);
    db.close();
  });

  test("migration ids are unique and ordered, so a released one is never renumbered", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(SCHEMA_VERSION).toBe(Math.max(...ids));
  });

  /**
   * The refusal this whole change exists for. A build that quietly ignores a
   * column a newer release relies on does not look broken until data stops
   * being read.
   */
  test("a profile from a newer Wisp is refused, and nothing is touched", () => {
    const db = freshDatabase("future");
    migrate(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
      SCHEMA_VERSION + 5,
      "from-the-future",
      new Date().toISOString(),
    );

    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    try {
      migrate(db);
    } catch (error) {
      expect((error as Error).message).toContain(`schema ${SCHEMA_VERSION + 5}`);
      expect((error as Error).message).toContain("restore a backup");
    }
    db.close();
  });

  test("the archive-cleanup table is part of the schema, not a side effect of importing a module", () => {
    const db = freshDatabase("tables");
    migrate(db);
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain("tasks");
    expect(tables).toContain("turns");
    expect(tables).toContain("task_messages");
    expect(tables).toContain("outbox");
    expect(tables).toContain("archive_cleanups");
    db.close();
  });
});

describe("upgrading a profile an earlier release left behind", () => {
  /**
   * The oldest shape in the guarded-ALTER history: tasks and turns without any
   * of the columns added since. A real profile has ROWS, and the assertion is
   * that they are still there and still readable afterwards.
   */
  test("an original-shape database keeps its rows and gains its columns", () => {
    const db = freshDatabase("ancient");
    db.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  base_commit TEXT,
  harness TEXT NOT NULL,
  model TEXT,
  slot INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  state_detail TEXT,
  session_id TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  exit_code INTEGER,
  log_file TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
`);
    db.query(
      `INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at)
       VALUES ('told01', 'an old task', '/tmp/repo', 'claude', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.query(
      `INSERT INTO turns (task_id, n, prompt, status, log_file, started_at)
       VALUES ('told01', 1, 'do the thing', 'done', '/tmp/log', '2026-01-01T00:00:00.000Z')`,
    ).run();

    migrate(db);

    // the rows survived
    expect(db.query("SELECT title FROM tasks WHERE id = 'told01'").get()).toEqual({ title: "an old task" });
    expect(db.query("SELECT prompt FROM turns WHERE task_id = 'told01'").get()).toEqual({ prompt: "do the thing" });
    // and every column the current build reads now exists
    for (const column of ["effort", "mode", "skills_json"]) expect(columns(db, "tasks")).toContain(column);
    for (const column of ["pid_start_time", "interrupt_detail", "model", "attachments_json", "usage_json", "capture_mode", "outcome_json", "diagnostic_state"]) {
      expect(columns(db, "turns")).toContain(column);
    }
    expect(ledger(db).map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    db.close();
  });

  /**
   * The likeliest real upgrade: a 0.4.0-alpha profile that already has every
   * pre-ledger column but no ledger. The baseline has to be safe to apply to
   * a database that is already in its final shape.
   */
  test("a pre-ledger profile with the current shape adopts the ledger without re-adding anything", () => {
    const donor = freshDatabase("donor");
    migrate(donor);
    const schema = (
      donor
        .query(
          `SELECT sql FROM sqlite_master
           WHERE sql IS NOT NULL AND name != 'schema_migrations' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as { sql: string }[]
    ).map((row) => row.sql);
    donor.close();

    const db = freshDatabase("preledger");
    for (const statement of schema) db.exec(statement);
    db.query(
      `INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at)
       VALUES ('tpre01', 'a dogfood task', '/tmp/repo', 'droid', 'needs-input', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
    ).run();
    db.query(
      `INSERT INTO task_messages (id, task_id, text, status, attachment_hash, created_at, updated_at)
       VALUES ('m1', 'tpre01', 'a queued correction', 'queued', '', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
    ).run();

    const result = migrate(db);

    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(db.query("SELECT text FROM task_messages WHERE id = 'm1'").get()).toEqual({
      text: "a queued correction",
    });
    expect(db.query("SELECT state FROM tasks WHERE id = 'tpre01'").get()).toEqual({ state: "needs-input" });
    db.close();
  });
});

/**
 * `wisp doctor`'s database check, which had no cases of its own: the existing
 * doctor receipts pass because a missing file reports "not created yet" (a
 * review's note). These are the three answers an operator acts on.
 */
describe("the doctor database check", () => {
  test("a migrated profile reports its schema and clean integrity", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-doctor-ok-"));
    const path = join(dir, "wisp.db");
    const db = new Database(path, { create: true });
    migrate(db);
    db.close();

    const check = checkDatabase(path);
    expect(check.status).toBe("ok");
    expect(check.message).toContain(`schema ${SCHEMA_VERSION} of ${SCHEMA_VERSION}`);
  });

  /** The state the INSTALL copy describes: never opened by a ledger-aware build. */
  test("a pre-ledger profile is schema 0, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-doctor-preledger-"));
    const path = join(dir, "wisp.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    db.close();

    const check = checkDatabase(path);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("schema 0 of");
  });

  test("a profile from a newer Wisp fails with the remedy", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-doctor-future-"));
    const path = join(dir, "wisp.db");
    const db = new Database(path, { create: true });
    migrate(db);
    db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
      SCHEMA_VERSION + 3,
      "from-the-future",
      "now",
    );
    db.close();

    const check = checkDatabase(path);
    expect(check.status).toBe("fail");
    expect(check.message).toContain("newer Wisp");
    expect(check.message).toContain("restore");
  });

  test("an unopened profile says so instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-doctor-missing-"));
    expect(checkDatabase(join(dir, "wisp.db")).status).toBe("ok");
  });

  /** The read-only claim: doctor must be usable while a daemon serves the home. */
  test("the check does not migrate or write the profile it reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-doctor-readonly-"));
    const path = join(dir, "wisp.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    db.close();

    checkDatabase(path);

    const after = new Database(path, { readonly: true });
    const ledger = after.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get();
    after.close();
    expect(ledger).toBeNull();
  });
});

describe("foreign keys and integrity", () => {
  test("a clean profile gets enforcement, and the declared cascade then actually applies", () => {
    const db = freshDatabase("fk-clean");
    migrate(db);
    expect(enforceForeignKeys(db)).toEqual({ enabled: true, violations: 0 });

    db.query(
      `INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at)
       VALUES ('tfk001', 'fk task', '/tmp/repo', 'claude', 'done', 'now', 'now')`,
    ).run();
    db.query(
      `INSERT INTO task_messages (id, task_id, text, status, attachment_hash, created_at, updated_at)
       VALUES ('mfk1', 'tfk001', 'msg', 'queued', '', 'now', 'now')`,
    ).run();
    // `REFERENCES tasks(id)` has always been DECLARED; without the pragma it
    // was decoration. A message for a task that does not exist is refused now.
    expect(() =>
      db
        .query(
          `INSERT INTO task_messages (id, task_id, text, status, attachment_hash, created_at, updated_at)
           VALUES ('mfk2', 'tnope', 'msg', 'queued', '', 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  /**
   * The reason this is a check rather than an unconditional pragma: the
   * declaration was unenforced for every previous release, so a profile can
   * have accumulated rows that would now be violations. Turning enforcement on
   * regardless would start refusing a user's next message.
   */
  test("a profile with existing violations keeps the old behavior instead of failing writes", () => {
    const db = freshDatabase("fk-dirty");
    migrate(db);
    db.query(
      `INSERT INTO task_messages (id, task_id, text, status, attachment_hash, created_at, updated_at)
       VALUES ('orphan', 'tgone', 'msg', 'queued', '', 'now', 'now')`,
    ).run();

    const result = enforceForeignKeys(db);
    expect(result.enabled).toBe(false);
    expect(result.violations).toBeGreaterThan(0);
    // still usable: the orphan is not a reason to refuse ordinary work
    db.query(
      `INSERT INTO tasks (id, title, repo_path, harness, state, created_at, updated_at)
       VALUES ('tafter', 'after', '/tmp/repo', 'claude', 'done', 'now', 'now')`,
    ).run();
    expect(db.query("SELECT id FROM tasks WHERE id = 'tafter'").get()).toEqual({ id: "tafter" });
    db.close();
  });

  test("a healthy database reports no integrity problems", () => {
    const db = freshDatabase("integrity");
    migrate(db);
    expect(integrityProblems(db)).toEqual([]);
    db.close();
  });
});
