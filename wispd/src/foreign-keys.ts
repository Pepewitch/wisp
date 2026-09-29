import type { Database } from "bun:sqlite";
import { SCHEMA_VERSION } from "./migrations";

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
 * rebuilding it. Permanent deletion explicitly removes dependent rows in one
 * transaction, including on older profiles without foreign-key enforcement.
 *
 * `foreign_key_check` walks every referencing row, so on a long history it is
 * the slowest thing a start does before listening. Its answer only changes when
 * rows are written with enforcement off, and this daemon writes with it on from
 * the moment the check passes. So a clean answer is remembered and trusted
 * until a migration runs (`recheck`, and the schema version it was recorded
 * under) or a week has passed, which bounds how long a row written outside Wisp
 * could go unnoticed. A profile with violations is checked on every start, as
 * before, and `wisp doctor --database` runs the full check on demand.
 */
export function enforceForeignKeys(
  db: Database,
  options: { recheck?: boolean; now?: number } = {},
): { enabled: boolean; violations: number } {
  const now = options.now ?? Date.now();
  if (!options.recheck && foreignKeysRecentlyClean(db, now)) {
    db.exec("PRAGMA foreign_keys = ON");
    return { enabled: true, violations: 0 };
  }
  const violations = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
  if (violations > 0) {
    forgetCheck(db, FOREIGN_KEY_CHECK);
    console.warn(
      `[wisp] foreign-key enforcement stayed OFF: this profile has ${violations} row(s) that would violate it. ` +
        `Nothing is broken by leaving it off — it is what every previous release did — but the rows are worth a look.`,
    );
    return { enabled: false, violations };
  }
  db.exec("PRAGMA foreign_keys = ON");
  recordCheck(db, FOREIGN_KEY_CHECK, now);
  return { enabled: true, violations: 0 };
}

const FOREIGN_KEY_CHECK = "foreign_key_check";
export const FOREIGN_KEY_RECHECK_MS = 7 * 86_400_000;

function hasChecksTable(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'database_checks'").get() !== null;
}

function foreignKeysRecentlyClean(db: Database, now: number): boolean {
  if (!hasChecksTable(db)) return false;
  const row = db.query("SELECT schema_version, checked_at FROM database_checks WHERE name = ?")
    .get(FOREIGN_KEY_CHECK) as { schema_version: number; checked_at: string } | null;
  if (row === null || row.schema_version !== SCHEMA_VERSION) return false;
  const age = now - Date.parse(row.checked_at);
  return age >= 0 && age < FOREIGN_KEY_RECHECK_MS;
}

function recordCheck(db: Database, name: string, now: number): void {
  if (!hasChecksTable(db)) return;
  db.query(
    `INSERT INTO database_checks (name, schema_version, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET schema_version = excluded.schema_version, checked_at = excluded.checked_at`,
  ).run(name, SCHEMA_VERSION, new Date(now).toISOString());
}

function forgetCheck(db: Database, name: string): void {
  if (hasChecksTable(db)) db.query("DELETE FROM database_checks WHERE name = ?").run(name);
}
