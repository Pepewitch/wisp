/**
 * Migration 28, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Migration } from "./migrations";

export const MESSAGE_SOURCE: Migration = {
  id: 28,
  name: "message-source",
  up: (db) => {
    // What wrote a message when the person did not, as JSON TurnSource
    // (shared/api/task.ts): autopilot's kind, PR and round, or a workflow's
    // type. The transcript labels the turn it starts from it, never from the
    // text. Every existing row reads NULL, which keeps the bubble it had:
    // its origin says Wisp wrote it, but not which part of Wisp or which
    // round, and a label is not guessed.
    const columns = db.query("PRAGMA table_info(task_messages)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "source_json")) db.exec("ALTER TABLE task_messages ADD COLUMN source_json TEXT");
  },
};
