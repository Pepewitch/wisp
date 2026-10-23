/**
 * Migration 9, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const TASK_WORKFLOWS: Migration = {
  id: 9,
  name: "task-workflows",
  up: (db) => {
    const columns = db.query("PRAGMA table_info(task_messages)").all() as { name: string }[];
    if (!columns.some(c => c.name === "workflow_id")) db.exec("ALTER TABLE task_messages ADD COLUMN workflow_id TEXT");
    db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  params_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK(state IN ('active','paused','completed')),
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  context_n INTEGER NOT NULL,
  wake_count INTEGER NOT NULL DEFAULT 0,
  check_count INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  next_check_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_due ON workflows(state, next_check_at);
CREATE INDEX IF NOT EXISTS idx_workflows_task ON workflows(task_id);
CREATE TABLE IF NOT EXISTS workflow_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_history ON workflow_history(workflow_id, id);
CREATE TABLE IF NOT EXISTS workflow_wakes (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  prior_checkpoint_json TEXT NOT NULL,
  PRIMARY KEY(workflow_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_task_messages_workflow ON task_messages(workflow_id);
CREATE TRIGGER IF NOT EXISTS workflows_cancel_message AFTER UPDATE OF status ON task_messages
WHEN OLD.workflow_id IS NOT NULL AND OLD.status = 'queued' AND NEW.status = 'cancelled' AND OLD.claim IS NULL AND OLD.delivery_uncertain = 0 BEGIN
  UPDATE workflows SET
    checkpoint_json = COALESCE((SELECT prior_checkpoint_json FROM workflow_wakes WHERE message_id = OLD.id AND workflow_id = OLD.workflow_id), checkpoint_json),
    wake_count = MAX(0, wake_count - 1)
  WHERE id = OLD.workflow_id;
END;
CREATE TRIGGER IF NOT EXISTS workflows_archive AFTER UPDATE OF archived ON tasks WHEN NEW.archived = 1 BEGIN
  UPDATE workflows SET state = 'completed', reason = 'Task archived', revision = revision + 1 WHERE task_id = NEW.id AND state != 'completed';
  UPDATE task_messages SET status = 'cancelled' WHERE task_id = NEW.id AND workflow_id IS NOT NULL AND status = 'queued' AND claim IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS workflows_context AFTER UPDATE OF context_n, harness, model, effort ON tasks
WHEN NEW.context_n != OLD.context_n OR NEW.harness != OLD.harness OR NEW.model IS NOT OLD.model OR NEW.effort IS NOT OLD.effort BEGIN
  UPDATE workflows SET state = 'paused', reason = 'Task agent or context changed; review and resume', revision = revision + 1 WHERE task_id = NEW.id AND state = 'active';
  UPDATE task_messages SET status = 'cancelled' WHERE task_id = NEW.id AND workflow_id IS NOT NULL AND status = 'queued' AND claim IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS workflows_delete BEFORE DELETE ON tasks BEGIN
  DELETE FROM workflow_history WHERE workflow_id IN (SELECT id FROM workflows WHERE task_id = OLD.id);
  DELETE FROM workflow_wakes WHERE workflow_id IN (SELECT id FROM workflows WHERE task_id = OLD.id);
  DELETE FROM workflows WHERE task_id = OLD.id;
END;
`);
  },
};
