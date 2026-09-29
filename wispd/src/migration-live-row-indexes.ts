/**
 * Migration 18, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const LIVE_ROW_INDEXES: Migration = {
  id: 18,
  name: "live-row-indexes",
  up: (db) => {
    // "Which turns are running" is asked by capacity checks on every send, by
    // the stuck loop and by prose backfill, and "which process groups are
    // live" every two seconds while any is. Both used to walk the whole table
    // — `turns` rows carry the prompt and result before `status`, so that walk
    // crossed overflow pages. Partial indexes hold only the live rows, so they
    // stay tiny however long the history grows. The WHERE clauses must match
    // the queries' own text for SQLite to use them.
    //
    // database_checks remembers when a whole-database check last came back
    // clean (foreign-keys.ts), so a start does not repeat a scan whose answer
    // cannot have changed.
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_turns_running ON turns(task_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_turn_process_groups_live ON turn_process_groups(task_id) WHERE state != 'none';
CREATE TABLE IF NOT EXISTS database_checks (
  name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  checked_at TEXT NOT NULL
);
`);
  },
};
