/**
 * A parent marking a child's waiting reports as handled (#527): it read the
 * child's result with `wisp result` or `wisp wait`, so the next delivery
 * should not present those reports as news. Explicit only: reading a result
 * acknowledges nothing by itself. Only the child's parent agent, or a person,
 * may do it (routes/report-ack.ts): a child must not drop its own reports.
 *
 * Only a turn that finished `done` can be handled this way. A failed turn,
 * one that ended needing input, a question, a stuck turn, a setup failure and
 * every PR event stay: they ask for action, not just reading. Nothing is
 * deleted; a handled row becomes `dropped` with its reason, as every other
 * dropped report is.
 */
import type { ReportAckResponse } from "../../shared/api/task";
import { db } from "./store";
import { cancelQueuedTaskMessage } from "./store-messages";
import { reportFraming, type ReportFacts } from "./subtask-reports";
import { refreshReportText } from "./subtask-report-queue";

export const HANDLED_REASON = "handled by the parent";

export type ReportAck = ReportAckResponse;

interface WaitingRow {
  id: string;
  message_id: string | null;
  facts_json: string;
  /** a queued row whose message a turn is already starting or steering */
  claimed: number;
}

/** The child's latest turn that finished, as markSuperseded counts them: background follow-ups have no result. */
function latestFinishedTurn(childId: string): number | null {
  return (db.query(`SELECT MAX(n) AS n FROM turns WHERE task_id = ? AND status IN ('done', 'failed')
    AND (origin IS NULL OR origin != 'background')`).get(childId) as { n: number | null } | null)?.n ?? null;
}

function handles(facts: ReportFacts, through: number): boolean {
  return facts.kind === "turn" && facts.outcome === "done" && facts.turn !== undefined && facts.turn <= through;
}

/**
 * Mark the child's waiting `done` turn reports up to `throughTurn` as
 * handled, in one transaction. The turn is the one the parent read, never
 * defaulted: "the latest" at ack time could be a turn that finished after the
 * read, whose report the parent never saw. A turn past the child's latest
 * finished one acknowledges only up to that one. A queued message left with
 * no report is cancelled; one that keeps some has its text rewritten to what
 * it will now deliver. A message a turn is already starting is past changing
 * and keeps its reports.
 */
export function ackReports(childId: string, throughTurn: number): ReportAck {
  return db.transaction((): ReportAck => {
    const latest = latestFinishedTurn(childId);
    const through = latest === null ? null : Math.min(throughTurn, latest);
    const rows = db.query(`SELECT r.id, r.message_id, r.facts_json,
        (m.id IS NOT NULL AND (m.claim IS NOT NULL OR m.status != 'queued')) AS claimed
      FROM subtask_reports r LEFT JOIN task_messages m ON m.id = r.message_id
      WHERE r.child_task_id = ? AND r.state IN ('pending', 'queued') ORDER BY r.created_at, r.rowid`).all(childId) as WaitingRow[];
    const handled = through === null
      ? []
      : rows.filter((row) => row.claimed === 0 && handles(JSON.parse(row.facts_json) as ReportFacts, through));
    const at = new Date().toISOString();
    for (const row of handled) {
      db.run("UPDATE subtask_reports SET state = 'dropped', reason = ?, updated_at = ? WHERE id = ?", [HANDLED_REASON, at, row.id]);
    }
    const cancelled: string[] = [];
    for (const messageId of new Set(handled.flatMap((row) => (row.message_id ? [row.message_id] : [])))) {
      const left = db.query("SELECT 1 FROM subtask_reports WHERE message_id = ? AND state = 'queued'").get(messageId) !== null;
      if (left) {
        refreshReportText(messageId, reportFraming(messageId));
        continue;
      }
      const message = db.query("SELECT task_id FROM task_messages WHERE id = ?").get(messageId) as { task_id: string } | null;
      if (message && cancelQueuedTaskMessage(messageId, message.task_id)) cancelled.push(messageId);
    }
    return { through, handled: handled.length, kept: rows.length - handled.length, cancelled };
  })();
}
