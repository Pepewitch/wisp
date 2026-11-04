import type { Migration } from "./migrations";

const STAMP = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * A subtask report may now reach a parent mid-turn: one waiting longer than
 * subtask-delivery.ts REPORT_STEER_AFTER_MS behind a running turn is steered
 * into it. Its rows are delivered the moment its message is, by either path,
 * so the trigger that marked them on `started` covers `steered` too.
 */
export const REPORT_STEERED: Migration = {
  id: 32,
  name: "report-steered",
  up: (db) => {
    db.exec(`DROP TRIGGER IF EXISTS subtask_reports_started;
CREATE TRIGGER subtask_reports_started AFTER UPDATE OF delivery ON task_messages
WHEN NEW.origin = 'subtask' AND NEW.delivery IN ('started', 'steered') BEGIN
  UPDATE subtask_reports SET state = 'delivered', updated_at = ${STAMP} WHERE message_id = NEW.id AND state = 'queued';
END;`);
  },
};
