import type { Migration } from "./migrations";

/** Tables a removed feature left behind; nothing has read or written them since. */
const RETIRED_TABLES = ["task_briefs", "brief_runs", "task_answer_observations"];
/** Its columns on `tasks`, likewise unread. */
const RETIRED_TASK_COLUMNS = ["brief_enabled", "brief_generation", "input_rev"];

/**
 * Drop the task-brief schema. Briefs were removed (#402) with their tables and
 * columns kept so a downgrade could still open the profile; every migration
 * since makes an older build refuse the profile anyway, so keeping them bought
 * nothing. A fresh profile never creates them (migrations 14 and 15), which is
 * why every drop here tolerates their absence. This is the one place the old
 * names live on: dropping them from existing profiles needs them.
 */
export const RETIRED_SCHEMA: Migration = {
  id: 33,
  name: "drop-retired-schema",
  up: (db) => {
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    const columns = (db.query(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
    for (const column of RETIRED_TASK_COLUMNS) {
      if (columns.includes(column)) db.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    }
  },
};
