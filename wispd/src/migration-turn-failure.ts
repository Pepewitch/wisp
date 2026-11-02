import type { Migration } from "./migrations";

/**
 * Why a turn failed, kept on the turn (turn-finalize.ts). Until now the reason
 * lived only in the task's state_detail, which the next turn overwrites, so a
 * failed turn 1 read "no result text" as soon as turn 2 ran. Turns settled
 * before this migration keep NULL: their reason was not stored anywhere.
 */
export const TURN_FAILURE: Migration = {
  id: 30,
  name: "turn-failure-detail",
  up: (db) => {
    const columns = db.query("PRAGMA table_info(turns)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "failure_detail")) {
      db.exec("ALTER TABLE turns ADD COLUMN failure_detail TEXT");
    }
  },
};
