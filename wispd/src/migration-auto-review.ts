/**
 * Migration 23, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const AUTO_REVIEW: Migration = {
  id: 23,
  name: "auto-review",
  up: (db) => {
    // Auto-review (verify/): each round is one reviewer task verifying one
    // head of an author task's PR, and its verdict. A task Wisp started for
    // verification says which kind it is in `verify_role` ('reviewer' or
    // 'recipe'); every existing task was an ordinary one, which NULL says.
    // Deleting either task removes its rows, as the delete trigger below does
    // whether or not foreign keys are enforced on this profile.
    const columns = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("verify_role")) db.exec("ALTER TABLE tasks ADD COLUMN verify_role TEXT");
    db.exec(`
CREATE TABLE IF NOT EXISTS auto_review_rounds (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT '',
  round INTEGER NOT NULL,
  counted INTEGER NOT NULL DEFAULT 1,
  reviewer_task_id TEXT,
  token TEXT NOT NULL,
  recipe_version TEXT,
  state TEXT NOT NULL,
  cause TEXT,
  summary TEXT,
  findings_json TEXT,
  recipe_feedback TEXT,
  recipe_area TEXT,
  evidence_json TEXT,
  nudged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auto_review_rounds_task ON auto_review_rounds(task_id, pr, created_at);
CREATE INDEX IF NOT EXISTS idx_auto_review_rounds_reviewer ON auto_review_rounds(reviewer_task_id);
CREATE TABLE IF NOT EXISTS verify_tasks (
  task_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  area TEXT,
  round_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_tasks_project ON verify_tasks(project_path, created_at);
CREATE TRIGGER IF NOT EXISTS auto_review_delete BEFORE DELETE ON tasks BEGIN
  DELETE FROM auto_review_rounds WHERE task_id = OLD.id;
  UPDATE auto_review_rounds SET reviewer_task_id = NULL WHERE reviewer_task_id = OLD.id;
  DELETE FROM verify_tasks WHERE task_id = OLD.id;
END;
`);
  },
};
