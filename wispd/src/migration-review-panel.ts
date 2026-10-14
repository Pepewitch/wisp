/**
 * Migration 24, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const REVIEW_PANEL: Migration = {
  id: 24,
  name: "review-panel",
  up: (db) => {
    // An auto-review round becomes a panel: one review per reviewer (the
    // primary, who verifies and reviews; a second, who reviews), each with its
    // own task, token and verdict. The round keeps the aggregate, written when
    // its last review ends, so older clients read what they always read.
    //
    // Every existing round had exactly one reviewer: it becomes that round's
    // primary review, protocol 1 (the phase-1 verdict shape), keeping its
    // token so a reviewer still running across the upgrade can still submit.
    db.exec(`
CREATE TABLE IF NOT EXISTS round_reviews (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  role TEXT NOT NULL,
  protocol INTEGER NOT NULL DEFAULT 2,
  reviewer_task_id TEXT,
  harness TEXT NOT NULL DEFAULT '',
  model TEXT,
  effort TEXT,
  token TEXT NOT NULL,
  state TEXT NOT NULL,
  cause TEXT,
  summary TEXT,
  rationale TEXT,
  findings_json TEXT,
  reviewed_json TEXT,
  recipe_feedback TEXT,
  recipe_area TEXT,
  evidence_json TEXT,
  escalated TEXT,
  carried_from TEXT,
  nudged INTEGER NOT NULL DEFAULT 0,
  launched_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_round_reviews_role ON round_reviews(round_id, role);
CREATE INDEX IF NOT EXISTS idx_round_reviews_task ON round_reviews(reviewer_task_id);
`);
    const columns = (db.query("PRAGMA table_info(auto_review_rounds)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("tier")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN tier TEXT");
    if (!columns.includes("signals_json")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN signals_json TEXT");
    if (!columns.includes("roles")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN roles TEXT");
    // 1: a phase-1 round (one reviewer, no rubric, no tier); new rounds are written as 2
    if (!columns.includes("protocol")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1");
    db.exec(`
INSERT OR IGNORE INTO round_reviews (id, round_id, role, protocol, reviewer_task_id, harness, token, state, cause, summary,
  findings_json, recipe_feedback, recipe_area, evidence_json, nudged, launched_at, created_at, finished_at)
SELECT 'v' || substr(r.id, 2), r.id, 'primary', 1, r.reviewer_task_id, COALESCE(t.harness, ''), r.token, r.state, r.cause, r.summary,
  r.findings_json, r.recipe_feedback, r.recipe_area, r.evidence_json, r.nudged, r.created_at, r.created_at, r.finished_at
FROM auto_review_rounds r LEFT JOIN tasks t ON t.id = r.reviewer_task_id;
UPDATE auto_review_rounds SET roles = '["primary"]' WHERE roles IS NULL;
DROP TRIGGER IF EXISTS auto_review_delete;
CREATE TRIGGER auto_review_delete BEFORE DELETE ON tasks BEGIN
  DELETE FROM round_reviews WHERE round_id IN (SELECT id FROM auto_review_rounds WHERE task_id = OLD.id);
  DELETE FROM auto_review_rounds WHERE task_id = OLD.id;
  UPDATE round_reviews SET reviewer_task_id = NULL WHERE reviewer_task_id = OLD.id;
  UPDATE auto_review_rounds SET reviewer_task_id = NULL WHERE reviewer_task_id = OLD.id;
  DELETE FROM verify_tasks WHERE task_id = OLD.id;
END;
`);
  },
};
