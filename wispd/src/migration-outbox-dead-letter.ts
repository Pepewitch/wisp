/**
 * Migration 19, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const OUTBOX_DEAD_LETTER: Migration = {
  id: 19,
  name: "outbox-dead-letter",
  up: (db) => {
    // When a webhook event first failed to deliver, and when delivery gave
    // up on it (too many attempts, or failing for too long) and kept it
    // undelivered for inspection rather than retrying forever. NULL for every
    // existing row: its next failure starts the clock, so a daemon upgraded
    // after a long stop does not retire old events on its first pass.
    const columns = (db.query("PRAGMA table_info(outbox)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("first_failed_at")) db.exec("ALTER TABLE outbox ADD COLUMN first_failed_at TEXT");
    if (!columns.includes("dead_at")) db.exec("ALTER TABLE outbox ADD COLUMN dead_at TEXT");
  },
};
