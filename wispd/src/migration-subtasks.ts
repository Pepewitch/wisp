/**
 * Migration 26: subtasks, a task that belongs to a parent task. Kept beside
 * the ledger (migrations.ts) because that file is at its size limit; it is
 * listed there in order like every other step.
 *
 * The whole schema lands at once, so the later steps of the feature (reports
 * to the parent, merge rights) need no migration of their own.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations";

function addColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((found) => found.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const STAMP = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const SUBTASKS: Migration = {
  id: 26,
  name: "subtasks",
  up: (db) => {
    // The relationship, fixed at creation. No foreign key: a deleted parent
    // only unlinks its children (the trigger below), never deletes them.
    addColumn(db, "tasks", "parent_task_id", "TEXT");
    // review | explore | continue; NULL for a root task
    addColumn(db, "tasks", "subtask_kind", "TEXT");
    addColumn(db, "tasks", "report_to_parent", "INTEGER NOT NULL DEFAULT 0");
    // where the pinned base came from: pr#N, parent:<id>, project, explicit
    addColumn(db, "tasks", "base_from", "TEXT");
    // who turned auto-merge on: person, parent:<id> or agent:<id>; NULL confers no rights
    addColumn(db, "tasks", "merge_granted_by", "TEXT");
    // the message that started a turn, written with the turn row itself
    addColumn(db, "turns", "source_message_id", "TEXT");
    // who sent a message (the task audit's actor), written when it is persisted
    addColumn(db, "task_messages", "actor", "TEXT");
    // the actor who last made a workflow's allowMerge true
    addColumn(db, "workflows", "merge_allowed_by", "TEXT");
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS subtask_reports (
  id TEXT PRIMARY KEY,
  child_task_id TEXT NOT NULL,
  parent_task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_key TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL,
  message_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(child_task_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_subtask_reports_parent ON subtask_reports(parent_task_id, state);
CREATE INDEX IF NOT EXISTS idx_subtask_reports_message ON subtask_reports(message_id);
CREATE TRIGGER IF NOT EXISTS subtasks_delete BEFORE DELETE ON tasks BEGIN
  UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = OLD.id;
  UPDATE subtask_reports SET state = 'dropped', reason = 'parent deleted', updated_at = ${STAMP}
    WHERE parent_task_id = OLD.id AND state IN ('pending', 'queued');
  DELETE FROM subtask_reports WHERE child_task_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS subtask_reports_started AFTER UPDATE OF delivery ON task_messages
WHEN NEW.origin = 'subtask' AND NEW.delivery = 'started' BEGIN
  UPDATE subtask_reports SET state = 'delivered', updated_at = ${STAMP} WHERE message_id = NEW.id AND state = 'queued';
END;
CREATE TRIGGER IF NOT EXISTS subtask_reports_cancelled AFTER UPDATE OF status ON task_messages
WHEN OLD.origin = 'subtask' AND OLD.status = 'queued' AND NEW.status = 'cancelled' BEGIN
  UPDATE subtask_reports SET state = 'dropped', reason = 'cancelled', updated_at = ${STAMP} WHERE message_id = OLD.id AND state = 'queued';
END;
CREATE TRIGGER IF NOT EXISTS subtasks_parent_archived AFTER UPDATE OF archived ON tasks WHEN NEW.archived = 1 BEGIN
  UPDATE task_messages SET status = 'cancelled' WHERE task_id = NEW.id AND origin = 'subtask' AND status = 'queued';
  UPDATE subtask_reports SET state = 'dropped', reason = 'parent archived', updated_at = ${STAMP}
    WHERE parent_task_id = NEW.id AND state = 'pending';
END;
`);
    // Existing reviewers become review subtasks of the task whose PR they
    // reviewed, live and archived alike: through their review's round, or the
    // round's own link from before review panels. A reviewer whose author is
    // already gone stays a top-level task, as it was.
    db.exec(`
UPDATE tasks SET subtask_kind = 'review', parent_task_id = (
  SELECT r.task_id FROM auto_review_rounds r
  WHERE (r.id IN (SELECT rr.round_id FROM round_reviews rr WHERE rr.reviewer_task_id = tasks.id) OR r.reviewer_task_id = tasks.id)
    AND EXISTS (SELECT 1 FROM tasks a WHERE a.id = r.task_id AND a.id != tasks.id)
  ORDER BY r.created_at DESC LIMIT 1
)
WHERE verify_role = 'reviewer' AND parent_task_id IS NULL AND EXISTS (
  SELECT 1 FROM auto_review_rounds r
  WHERE (r.id IN (SELECT rr.round_id FROM round_reviews rr WHERE rr.reviewer_task_id = tasks.id) OR r.reviewer_task_id = tasks.id)
    AND EXISTS (SELECT 1 FROM tasks a WHERE a.id = r.task_id AND a.id != tasks.id)
);
`);
  },
};
