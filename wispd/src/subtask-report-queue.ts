/**
 * Turning a parent's recorded subtask reports into the message that delivers
 * them (subtask-delivery.ts), and the rule that keeps them from starving
 * behind a parent that is always sent something (runner.ts). Beside
 * subtask-reports.ts, which may import only the database handle.
 */
import { randomBytes } from "node:crypto";
import { createTaskMessage, db } from "./store";
import { reportFraming } from "./subtask-reports";
import type { Task, TaskMessage } from "./types";

/** A Stop the person pressed holds the parent's automation until their next turn: a report waits for it too. */
export function heldAfterStop(taskId: string): boolean {
  return db.query(`SELECT 1 FROM workflows WHERE task_id = ? AND state != 'completed'
    AND json_valid(checkpoint_json) AND json_extract(checkpoint_json, '$.stopHold') IS NOT NULL`).get(taskId) !== null;
}

/** The report message already queued for a parent, oldest first. */
export function queuedReport(parentId: string): string | null {
  const row = db.query(`SELECT id FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued'
    ORDER BY source_seq, rowid LIMIT 1`).get(parentId) as { id: string } | null;
  return row?.id ?? null;
}

/**
 * Every pending row of a parent, as one queued message, in one transaction.
 * Its text is what the transcript shows; the framing the parent receives is
 * built from the rows (reportFraming).
 */
export function queueReports(parent: Pick<Task, "id">): string | null {
  return db.transaction((): string | null => {
    const rows = db.query("SELECT id FROM subtask_reports WHERE parent_task_id = ? AND state = 'pending' ORDER BY created_at, rowid")
      .all(parent.id) as { id: string }[];
    if (rows.length === 0) return null;
    const id = `ms${randomBytes(9).toString("hex")}`;
    // mark them first, so the framing below reads exactly this message's rows
    const at = new Date().toISOString();
    for (const row of rows) db.run("UPDATE subtask_reports SET state = 'queued', message_id = ?, updated_at = ? WHERE id = ?", [id, at, row.id]);
    const framed = reportFraming(id);
    createTaskMessage({
      id, taskId: parent.id, text: [...framed.lines, ...(framed.words ? ["", framed.words] : [])].join("\n"),
      attachmentHash: "", origin: "subtask", actor: "system",
    });
    return id;
  })();
}

/**
 * The report message a parent's next turn should start instead of `head`, the
 * next message in line: one admitted before it. Delivery queues a busy
 * parent's reports as they arrive (subtask-delivery.ts), so they hold their
 * place among the person's messages; without this a parent that is always
 * sent something never settled, and its reports never went (#499). Never
 * over a parent that needs the person, or that a Stop holds.
 */
export function reportBefore(parent: Pick<Task, "id" | "state">, head: Pick<TaskMessage, "source_seq">): string | null {
  if ((parent.state !== "done" && parent.state !== "failed") || heldAfterStop(parent.id)) return null;
  const row = db.query(`SELECT id FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued' AND claim IS NULL
    AND source_seq < ? ORDER BY source_seq, rowid LIMIT 1`).get(parent.id, head.source_seq ?? 0) as { id: string } | null;
  return row?.id ?? null;
}
