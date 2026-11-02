import type { Migration } from "./migrations";

/**
 * A parent's message to a subtask marked to report back (`wisp send
 * --report`): the child turn it reaches reports to the parent, which the
 * loop breaker in subtask-reports.ts otherwise stops for the parent's own
 * messages. NULL on every older row, which keeps that rule.
 */
export const MESSAGE_REPORT: Migration = {
  id: 31,
  name: "message-report-back",
  up: (db) => {
    const columns = db.query("PRAGMA table_info(task_messages)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "report_back")) {
      db.exec("ALTER TABLE task_messages ADD COLUMN report_back INTEGER");
    }
  },
};
