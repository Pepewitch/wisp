/**
 * Migration 17, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const WORKFLOW_HISTORY_TRAIL: Migration = {
  id: 17,
  name: "workflow-history-trail",
  up: (db) => {
    // A history entry can name the pull request and the commit it is about
    // (autopilot: which PR a look, a round or a merge was for, and which
    // head it merged). NULL for every existing entry: they never said.
    const columns = (db.query("PRAGMA table_info(workflow_history)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("pr")) db.exec("ALTER TABLE workflow_history ADD COLUMN pr INTEGER");
    if (!columns.includes("sha")) db.exec("ALTER TABLE workflow_history ADD COLUMN sha TEXT");

    // The archive and agent-change guards complete or pause workflows in
    // SQL, where no runtime code writes history afterwards: the history of
    // every archived task's workflows just stopped, with nothing saying why.
    // They now write the entry changeWorkflowState would, and move
    // updated_at, since the reason changed. DROP + CREATE because a
    // trigger's body cannot be altered.
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const pr = "CASE WHEN type = 'pr-autopilot' AND json_valid(checkpoint_json) THEN json_extract(checkpoint_json, '$.pr') END";
    db.exec(`
DROP TRIGGER IF EXISTS workflows_archive;
CREATE TRIGGER workflows_archive AFTER UPDATE OF archived ON tasks WHEN NEW.archived = 1 BEGIN
  INSERT INTO workflow_history(workflow_id, at, kind, detail, pr)
    SELECT id, ${now}, 'completed', 'Task archived', ${pr} FROM workflows WHERE task_id = NEW.id AND state != 'completed';
  UPDATE workflows SET state = 'completed', reason = 'Task archived', revision = revision + 1, updated_at = ${now} WHERE task_id = NEW.id AND state != 'completed';
  UPDATE task_messages SET status = 'cancelled' WHERE task_id = NEW.id AND workflow_id IS NOT NULL AND status = 'queued' AND claim IS NULL;
END;
DROP TRIGGER IF EXISTS workflows_context;
CREATE TRIGGER workflows_context AFTER UPDATE OF context_n, harness, model, effort, fast ON tasks
WHEN NEW.context_n != OLD.context_n OR NEW.harness != OLD.harness OR NEW.model IS NOT OLD.model OR NEW.effort IS NOT OLD.effort OR NEW.fast != OLD.fast BEGIN
  INSERT INTO workflow_history(workflow_id, at, kind, detail, pr)
    SELECT id, ${now}, 'paused', 'Task agent or context changed; review and resume', ${pr} FROM workflows WHERE task_id = NEW.id AND state = 'active';
  UPDATE workflows SET state = 'paused', reason = 'Task agent or context changed; review and resume', revision = revision + 1, updated_at = ${now} WHERE task_id = NEW.id AND state = 'active';
  UPDATE task_messages SET status = 'cancelled' WHERE task_id = NEW.id AND workflow_id IS NOT NULL AND status = 'queued' AND claim IS NULL;
END;
`);
  },
};
