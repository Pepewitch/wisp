/**
 * Turning a parent's recorded subtask reports into the message that delivers
 * them (subtask-delivery.ts), and the rule that keeps them from starving
 * behind a parent that is always sent something (runner.ts). Beside
 * subtask-reports.ts, which may import only the database handle.
 */
import { randomBytes } from "node:crypto";
import { emit } from "./events";
import { createTaskMessage, db } from "./store";
import { reportFraming } from "./subtask-reports";
import { backgroundHoldsReport } from "./autopilot/idle";
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

/** At most this many reports go in one message; the rest wait, in order, for the next (#519). */
export const REPORT_BATCH_MAX_REPORTS = 10;
/**
 * And at most about this much of the children's words, as stored (a report
 * later marked superseded still counts its words here): a batch stops before
 * the report that would pass it.
 */
export const REPORT_BATCH_MAX_CHARS = 12_000;

/**
 * The oldest pending rows of a parent, as one queued message, in one
 * transaction: at most REPORT_BATCH_MAX_REPORTS, and no more children's words
 * than REPORT_BATCH_MAX_CHARS (always at least one report). The rest stay
 * pending for the next message, so a parent busy while many reports arrive
 * gets them in bounded, ordered batches rather than one that grows without
 * limit. Its text is what the transcript shows; the framing the parent
 * receives is built from the rows (reportFraming).
 */
export function queueReports(parent: Pick<Task, "id">): string | null {
  return db.transaction((): string | null => {
    const pending = db.query("SELECT id, length(coalesce(body, '')) AS chars FROM subtask_reports WHERE parent_task_id = ? AND state = 'pending' ORDER BY created_at, rowid")
      .all(parent.id) as { id: string; chars: number }[];
    const rows: { id: string }[] = [];
    let chars = 0;
    for (const row of pending) {
      if (rows.length >= REPORT_BATCH_MAX_REPORTS || (rows.length > 0 && chars + row.chars > REPORT_BATCH_MAX_CHARS)) break;
      rows.push(row);
      chars += row.chars;
    }
    if (rows.length === 0) return null;
    const id = `ms${randomBytes(9).toString("hex")}`;
    // mark them first, so the framing below reads exactly this message's rows
    const at = new Date().toISOString();
    for (const row of rows) db.run("UPDATE subtask_reports SET state = 'queued', message_id = ?, updated_at = ? WHERE id = ?", [id, at, row.id]);
    const framed = reportFraming(id);
    createTaskMessage({
      id, taskId: parent.id, text: reportText(framed),
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
 * over a parent that needs the person or that a Stop holds, nor while its
 * background work still holds reports back (autopilot/idle.ts).
 */
export function reportBefore(parent: Pick<Task, "id" | "state">, head: Pick<TaskMessage, "source_seq">): string | null {
  if ((parent.state !== "done" && parent.state !== "failed") || heldAfterStop(parent.id)) return null;
  // background work still running holds a report back for a while, as delivery's own readiness does (autopilot/idle.ts)
  if (backgroundHoldsReport(parent.id)) return null;
  const row = db.query(`SELECT id FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued' AND claim IS NULL
    AND source_seq < ? ORDER BY source_seq, rowid LIMIT 1`).get(parent.id, head.source_seq ?? 0) as { id: string } | null;
  return row?.id ?? null;
}

/** A report message's transcript text: Wisp's lines, then the children's fenced words. */
function reportText(framed: { lines: string[]; words: string }): string {
  return [...framed.lines, ...(framed.words ? ["", framed.words] : [])].join("\n");
}

/**
 * The report message's transcript text, rewritten to the framing its parent
 * receives now. The framing is built again when the message starts (a turn
 * report the child has moved past is marked superseded then), so the text
 * stored at queue time could otherwise show words the parent never got.
 */
export function refreshReportText(messageId: string, framed: { lines: string[]; words: string; found: boolean }): void {
  // with its rows gone, the text stored at queue time is the only record of what the children said
  if (!framed.found) return;
  const row = db.query("SELECT task_id, text FROM task_messages WHERE id = ? AND origin = 'subtask'").get(messageId) as { task_id: string; text: string } | null;
  const text = reportText(framed);
  if (!row || row.text === text) return;
  db.run("UPDATE task_messages SET text = ?, updated_at = ? WHERE id = ?", [text, new Date().toISOString(), messageId]);
  // an open transcript shows the new text, as for any other change to a message
  emit({ type: "message", taskId: row.task_id, messageId });
}
