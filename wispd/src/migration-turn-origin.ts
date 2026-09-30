/**
 * Migration 21, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const TURN_ORIGIN: Migration = {
  id: 21,
  name: "turn-origin",
  up: (db) => {
    // Who asked for a turn. NULL is a message: the person's, or one Wisp or
    // a workflow queued. 'background' is a model call that work the agent
    // started in the background woke on its own after the answer (a Claude
    // Monitor event, a background command finishing). Such a turn raises no
    // finish notification: nobody asked for it. Every existing row was a
    // message's turn, which NULL says.
    const columns = (db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("origin")) db.exec("ALTER TABLE turns ADD COLUMN origin TEXT");
  },
};
