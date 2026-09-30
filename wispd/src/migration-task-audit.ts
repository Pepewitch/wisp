/**
 * Migration 20, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const TASK_AUDIT: Migration = {
  id: 20,
  name: "task-audit",
  up: (db) => {
    // Who took each consequential action on a task (task-audit.ts): a
    // client, an agent inside another task, autopilot or the daemon itself.
    // Nothing recorded this before, so it starts empty. Permanent deletion
    // removes a task's rows with it; each task keeps its newest entries.
    db.exec(`
CREATE TABLE IF NOT EXISTS task_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_audit_task ON task_audit(task_id, id);
`);
  },
};
