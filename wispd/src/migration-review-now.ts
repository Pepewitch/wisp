/**
 * Migration 29, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const REVIEW_NOW: Migration = {
  id: 29,
  name: "review-now",
  up: (db) => {
    // A round a person started with Review now (autopilot/review-now.ts), or a
    // re-run of one, is reviewed and acted on whatever its head's checks say.
    // The round row says so, written with the round, so no later look depends
    // on a checkpoint write that a moved revision can drop. Every existing
    // round waited for its checks, which 0 says.
    const columns = db.query("PRAGMA table_info(auto_review_rounds)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "early")) db.exec("ALTER TABLE auto_review_rounds ADD COLUMN early INTEGER NOT NULL DEFAULT 0");
  },
};
