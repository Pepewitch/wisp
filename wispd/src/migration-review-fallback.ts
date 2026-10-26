/**
 * Migration 27, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const REVIEW_FALLBACK: Migration = {
  id: 27,
  name: "review-fallback",
  up: (db) => {
    // A review whose first agent failed for an infrastructure reason is run
    // once more by its role's fallback agent (verify/fallback.ts). The row
    // stays the role's one review; this records whom the fallback replaced
    // and why. Every existing review ran on its first agent, which NULL says.
    const columns = db.query("PRAGMA table_info(round_reviews)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "fallback_json")) db.exec("ALTER TABLE round_reviews ADD COLUMN fallback_json TEXT");
  },
};
