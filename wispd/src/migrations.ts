/**
 * The schema, as an ordered ledger (ENG-06).
 *
 * `store.ts` used to initialize the schema by running `CREATE TABLE IF NOT
 * EXISTS` and then a growing list of `PRAGMA table_info` checks followed by
 * `ALTER TABLE`, at module import. Every statement was individually
 * idempotent, which is why it worked — but a review named what it could not
 * do: there was no record of what had been applied, no version to compare
 * against, and therefore no way to REFUSE a profile written by a newer Wisp.
 * A build that does not understand a column silently ignores it, and the
 * first thing the user notices is data that stopped being read.
 *
 * So: numbered migrations, each applied once inside a transaction, recorded in
 * `schema_migrations`, and a profile whose highest applied id exceeds this
 * build's knowledge is a loud refusal rather than a quiet downgrade.
 *
 * The baseline is deliberately the whole pre-ledger schema, guards included.
 * Existing profiles already have those columns, so the baseline has to be
 * safe to "apply" to a database that is already in that shape — and it is,
 * statement by statement. Every migration AFTER the baseline may assume the
 * ledger, and must be written as an ordered, transactional step.
 */
import type { Database } from "bun:sqlite";

export interface Migration {
  /** Monotonic; never renumber a released one. */
  id: number;
  name: string;
  up(db: Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "baseline-pre-ledger-schema",
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
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
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  pid_start_time TEXT,
  interrupt_detail TEXT,
  exit_code INTEGER,
  log_file TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  capture_mode TEXT,
  capture_state TEXT,
  captured_bytes INTEGER,
  omitted_bytes INTEGER,
  omitted_records INTEGER,
  capture_categories_json TEXT,
  capture_detail TEXT,
  outcome_json TEXT,
  kill_detail TEXT,
  diagnostic_state TEXT,
  diagnostic_bytes INTEGER,
  diagnostic_first_seq INTEGER,
  diagnostic_last_seq INTEGER,
  diagnostic_detail TEXT,
  diagnostic_evicted_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','delivered','cancelled')) DEFAULT 'queued',
  delivery TEXT CHECK(delivery IN ('started','steered')),
  turn_n INTEGER,
  claim TEXT CHECK(claim IN ('started','steered')),
  claim_turn_n INTEGER,
  attachment_hash TEXT NOT NULL,
  delivery_uncertain INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

      // Migration (a prior audit): databases created before pid_start_time existed.
      // A pid without its start time can't be identity-checked, so old rows keep
      // NULL here and re-adoption falls back to bare liveness for them.
      const turnCols = db.query(`PRAGMA table_info(turns)`).all() as { name: string }[];
      if (!turnCols.some((c) => c.name === "pid_start_time")) {
        db.exec(`ALTER TABLE turns ADD COLUMN pid_start_time TEXT`);
      }
      // Migration (a prior audit): interrupt intent must survive a daemon crash
      // between the kill and the finalize — it lives on the turn row, like pid,
      // not in daemon memory.
      if (!turnCols.some((c) => c.name === "interrupt_detail")) {
        db.exec(`ALTER TABLE turns ADD COLUMN interrupt_detail TEXT`);
      }
      // Migration (P5b): the model each turn ACTUALLY ran on, parsed from the
      // harness's init/start event. NULL for turns that predate the column and for
      // harnesses that never report one (codex) — the surfaces then fall back to
      // the requested model, marked "(requested)".
      if (!turnCols.some((c) => c.name === "model")) {
        db.exec(`ALTER TABLE turns ADD COLUMN model TEXT`);
      }
      // Migration (A1a): the turn's attachment manifest — [{name, size, mediaType}]
      // as JSON, or NULL for a turn that carried no images. It lives on the turn row
      // rather than being read back off the directory because archive deletes the
      // image bytes (Q4): the record has to outlive them, or an archived conversation
      // silently forgets an image was ever there. NULL is not "[]": a turn that
      // predates this column never had the feature, and must not claim it did.
      if (!turnCols.some((c) => c.name === "attachments_json")) {
        db.exec(`ALTER TABLE turns ADD COLUMN attachments_json TEXT`);
      }
      // Migration (Theme B): the harness's own usage report per turn, one raw JSON
      // blob — the shapes differ per harness, so the blob is the fact and the
      // adapter's usageFormat normalizes at the API boundary. Emit-only: token
      // counts are facts; a price table would be a product statement that rots.
      if (!turnCols.some((c) => c.name === "usage_json")) {
        db.exec(`ALTER TABLE turns ADD COLUMN usage_json TEXT`);
      }
      // Bounded-recorder foundation. NULL capture_mode is intentional authority:
      // the process was launched under legacy whole-log semantics and recovery must
      // never reinterpret it using whatever adapter happens to be installed later.
      for (const [name, sqlType] of [
        ["capture_mode", "TEXT"],
        ["capture_state", "TEXT"],
        ["captured_bytes", "INTEGER"],
        ["omitted_bytes", "INTEGER"],
        ["omitted_records", "INTEGER"],
        ["capture_categories_json", "TEXT"],
        ["capture_detail", "TEXT"],
        ["outcome_json", "TEXT"],
        ["kill_detail", "TEXT"],
        ["diagnostic_state", "TEXT"],
        ["diagnostic_bytes", "INTEGER"],
        ["diagnostic_first_seq", "INTEGER"],
        ["diagnostic_last_seq", "INTEGER"],
        ["diagnostic_detail", "TEXT"],
        ["diagnostic_evicted_at", "TEXT"],
      ] as const) {
        if (!turnCols.some((column) => column.name === name)) {
          db.exec(`ALTER TABLE turns ADD COLUMN ${name} ${sqlType}`);
        }
      }

      // Migration (P5b): per-task reasoning effort, snapshotted from config
      // harnessDefaults at creation and passed to adapters with an effort template.
      const taskCols = db.query(`PRAGMA table_info(tasks)`).all() as { name: string }[];
      if (!taskCols.some((c) => c.name === "effort")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN effort TEXT`);
      }

      // Migration: run mode. Deliberately NOT backfilled and NOT defaulted in SQL —
      // every existing row predates local mode and is therefore a worktree task, and
      // taskMode() reads NULL as exactly that. A DEFAULT would claim the column was
      // always written, which archive (the one place that must never guess) relies
      // on being able to tell apart.
      if (!taskCols.some((c) => c.name === "mode")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN mode TEXT`);
      }

      // Migration (A4): the skill names the task's session announced on its init
      // event, as a JSON array (claude — SP2). NULL for tasks that predate the
      // column and for harnesses whose init carries no such list; [] is a real
      // answer ("this session has no skills"), never collapsed into NULL.
      if (!taskCols.some((c) => c.name === "skills_json")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN skills_json TEXT`);
      }

      // Incremental task-message migrations. The table is new in D20, but keeping
      // each addition independent lets development builds and future patch releases
      // open a database created by an earlier slice of the feature. The empty hash
      // on a pre-hash row preserves its old text-only retry identity; every new row
      // writes a full attachment fingerprint.
      const messageCols = new Set(
        (db.query(`PRAGMA table_info(task_messages)`).all() as { name: string }[]).map((column) => column.name),
      );
      if (!messageCols.has("claim")) {
        db.exec(`ALTER TABLE task_messages ADD COLUMN claim TEXT CHECK(claim IN ('started','steered'))`);
      }
      if (!messageCols.has("claim_turn_n")) {
        db.exec(`ALTER TABLE task_messages ADD COLUMN claim_turn_n INTEGER`);
      }
      if (!messageCols.has("attachment_hash")) {
        db.exec(`ALTER TABLE task_messages ADD COLUMN attachment_hash TEXT NOT NULL DEFAULT ''`);
      }
      if (!messageCols.has("delivery_uncertain")) {
        db.exec(`ALTER TABLE task_messages ADD COLUMN delivery_uncertain INTEGER NOT NULL DEFAULT 0`);
      }
      if (!messageCols.has("attachments_json")) {
        db.exec(`ALTER TABLE task_messages ADD COLUMN attachments_json TEXT`);
      }

      // Indexes/constraints (a prior audit). IF NOT EXISTS makes these idempotent
      // migrations for databases created before they existed. turns(task_id, n)
      // uniqueness lives in an index because SQLite can't ADD CONSTRAINT to a live
      // table; a unique index enforces it the same way.
      db.exec(`
CREATE INDEX IF NOT EXISTS idx_turns_task_id ON turns(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_task_id_n ON turns(task_id, n);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_task_messages_queue ON task_messages(task_id, status, created_at, id);
`);
    },
  },
  {
    id: 2,
    name: "archive-cleanup-jobs",
    up: (db) => {
      // Archive's destructive half, as a durable job (ENG-04). It also carries
      // the hook the archive started with: a project can be removed between
      // the flip and the teardown, and the archive script configured at that
      // moment is the one that must run.
      db.exec(`
CREATE TABLE IF NOT EXISTS archive_cleanups (
  task_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  force INTEGER NOT NULL,
  stop_turn INTEGER NOT NULL,
  removable INTEGER NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  archive_script TEXT,
  timeout_minutes INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    },
  },
];

/** The newest schema this build knows how to run. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.id), 0);

/** A profile from the future: readable enough to identify, not to use. */
export class SchemaTooNewError extends Error {
  constructor(readonly found: number) {
    super(
      `this Wisp home was written by a newer Wisp (schema ${found}); this build understands up to ${SCHEMA_VERSION}. ` +
        `Upgrade Wisp, or restore a backup taken before the upgrade — continuing would silently ignore columns the newer build relies on.`,
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Bring `db` up to `SCHEMA_VERSION`, or refuse.
 *
 * Each migration runs inside a transaction together with the ledger row that
 * records it, so an interrupted upgrade is either fully applied or not applied
 * at all. `PRAGMA journal_mode` is set outside a transaction because SQLite
 * will not change it inside one.
 */
export function migrate(db: Database): { applied: number[]; version: number } {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
  const applied = new Set(
    (db.query("SELECT id FROM schema_migrations").all() as { id: number }[]).map((row) => row.id),
  );
  const highest = [...applied].reduce((max, id) => Math.max(max, id), 0);
  if (highest > SCHEMA_VERSION) throw new SchemaTooNewError(highest);

  const ran: number[] = [];
  for (const migration of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    })();
    ran.push(migration.id);
  }
  return { applied: ran, version: SCHEMA_VERSION };
}

/**
 * Turn on foreign-key enforcement, but only after asking whether this profile
 * can survive it.
 *
 * `task_messages` has always DECLARED `REFERENCES tasks(id) ON DELETE
 * CASCADE`, and SQLite has always ignored it, because `PRAGMA foreign_keys`
 * defaults to off and nothing turned it on. Enabling it on a profile that
 * accumulated orphan rows while it was off would start rejecting ordinary
 * writes, so the existing rows are checked first: a clean profile gets
 * enforcement, and a profile with violations keeps the old behavior and says
 * so, loudly, instead of failing a user's next message.
 *
 * `turns` still has no declared foreign key. Adding one to a live table means
 * rebuilding it, which is a migration with real risk and no user-visible
 * benefit until something actually deletes tasks — and nothing does yet.
 */
export function enforceForeignKeys(db: Database): { enabled: boolean; violations: number } {
  const violations = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
  if (violations > 0) {
    console.warn(
      `[wisp] foreign-key enforcement stayed OFF: this profile has ${violations} row(s) that would violate it. ` +
        `Nothing is broken by leaving it off — it is what every previous release did — but the rows are worth a look.`,
    );
    return { enabled: false, violations };
  }
  db.exec("PRAGMA foreign_keys = ON");
  return { enabled: true, violations: 0 };
}

/**
 * A fast structural check of the database file, for `wisp doctor`. `quick_check`
 * rather than `integrity_check`: it skips the expensive index cross-checks and
 * still names a corrupt page, which is the failure an operator can act on.
 */
export function integrityProblems(db: Database): string[] {
  const rows = db.query("PRAGMA quick_check").all() as { quick_check?: string }[];
  return rows.map((row) => row.quick_check ?? "").filter((line) => line !== "" && line !== "ok");
}
