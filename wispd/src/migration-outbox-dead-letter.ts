/**
 * Migration 19, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const OUTBOX_DEAD_LETTER: Migration = {
  id: 19,
  name: "outbox-dead-letter",
  up: (db) => {
    // When delivery gave up on a webhook event: it had failed for too many
    // attempts or for too long, and is kept undelivered for inspection
    // rather than retried forever. NULL for every existing row, which the
    // next pass either delivers or retires under the same limits.
    const columns = (db.query("PRAGMA table_info(outbox)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("dead_at")) db.exec("ALTER TABLE outbox ADD COLUMN dead_at TEXT");
  },
};
