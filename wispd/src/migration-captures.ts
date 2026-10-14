/**
 * Migration 25, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const CAPTURES: Migration = {
  id: 25,
  name: "captures",
  up: (db) => {
    // One row per `wisp capture` attempt, failed ones included: what Wisp
    // itself saw, so "Chrome was missing" or "the page answered 404" is a
    // daemon fact rather than an agent's note. The image stays in the turn's
    // output manifest as an ordinary published image (older daemons keep it);
    // its provenance lives here, one row per occurrence even when two shots
    // share their bytes.
    db.exec(`
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  image_id TEXT,
  review_id TEXT,
  area TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  message TEXT,
  requested_url TEXT NOT NULL,
  final_url TEXT,
  http_status INTEGER,
  viewport TEXT NOT NULL,
  dpr REAL,
  width INTEGER,
  height INTEGER,
  media_type TEXT,
  full_page INTEGER NOT NULL DEFAULT 0,
  clipped INTEGER NOT NULL DEFAULT 0,
  selector_used INTEGER NOT NULL DEFAULT 0,
  script_used INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 1,
  served_from TEXT,
  errors_json TEXT,
  blocked_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captures_task ON captures(task_id, turn);
CREATE INDEX IF NOT EXISTS idx_captures_review ON captures(review_id);
DROP TRIGGER IF EXISTS captures_delete;
CREATE TRIGGER captures_delete BEFORE DELETE ON tasks BEGIN
  DELETE FROM captures WHERE task_id = OLD.id;
END;
`);
    // the areas a round's verifying reviewer must show with a capture, fixed when the round is planned
    const columns = (db.query("PRAGMA table_info(auto_review_rounds)").all() as { name: string }[]).map((c) => c.name);
    // (evidence_json is phase 1's: the images a round's reviewers published)
    if (!columns.includes("required_json")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN required_json TEXT");
    // a verifying reviewer's word for an area it could not capture, accepted only beside Wisp's record of why
    const reviewColumns = (db.query("PRAGMA table_info(round_reviews)").all() as { name: string }[]).map((c) => c.name);
    if (!reviewColumns.includes("waivers_json")) db.exec("ALTER TABLE round_reviews ADD COLUMN waivers_json TEXT");
  },
};
