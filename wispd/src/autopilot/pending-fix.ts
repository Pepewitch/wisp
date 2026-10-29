/**
 * What a person does to a round auto-fix holds: Send now, Skip, or cancel it
 * from the message list once it is queued. Each marks exactly the evidence
 * the round's key names. Beside store.ts because that file is at its size limit.
 */
import type { AutopilotStatus } from "../../../shared/autopilot"
import { db } from "../store-database"
import { announceWorkflow, getWorkflow, recordWorkflow } from "../workflows/store"
import { keyParts, withDelivered } from "./feedback"
import { AutopilotError, autopilotRow, autopilotStatus, checkpointOf, type AutopilotCheckpoint } from "./store"
import { AUTOPILOT_TYPE } from "./type"

/** A round's evidence, skipped: its CI part is never sent, its review items count as seen, and so do its auto-review findings. */
function handled(checkpoint: AutopilotCheckpoint, key: string): void {
  const parts = keyParts(key)
  if (parts.ci) checkpoint.skipped = [...(checkpoint.skipped ?? []).slice(-20), parts.ci]
  checkpoint.delivered = withDelivered(checkpoint.delivered, parts.delivered)
  if (parts.reviews.length > 0) checkpoint.reviewsSent = withReviewsSent(checkpoint.reviewsSent, parts.reviews)
}

/** The bounded list of auto-review rounds whose findings are handled. */
export function withReviewsSent(list: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...(list ?? []).filter((id) => !added.includes(id)), ...added].slice(-20)
}
/** Send now: skip the short delay before a pending round. */
export function sendPendingFix(taskId: string, now = new Date()): AutopilotStatus {
  return touchPending(taskId, now, (checkpoint) => { checkpoint.sendNow = checkpoint.pending!.key })
}

/** Skip: never send this evidence. A later head brings new evidence, and a round again. */
export function skipPendingFix(taskId: string, now = new Date()): AutopilotStatus {
  return touchPending(taskId, now, (checkpoint) => {
    handled(checkpoint, checkpoint.pending!.key)
    delete checkpoint.pending
    delete checkpoint.sendNow
  })
}

function touchPending(taskId: string, now: Date, change: (checkpoint: AutopilotCheckpoint) => void): AutopilotStatus {
  const row = autopilotRow(taskId)
  if (!row || row.state !== "active") throw new AutopilotError("Auto-fix is not on for this task", 409)
  const checkpoint = checkpointOf(row)
  if (!checkpoint.pending) throw new AutopilotError("No auto-fix round is waiting to be sent", 409)
  change(checkpoint)
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(checkpoint), now.toISOString(), now.toISOString(), row.id])
  announceWorkflow(taskId)
  return autopilotStatus(taskId)
}

/** A person cancelled a queued round from the message list: that means Skip, not a pause. */
export function skipCancelledRound(workflowId: string, messageId: string): boolean {
  const row = getWorkflow(workflowId)
  if (!row || row.type !== AUTOPILOT_TYPE) return false
  const wake = db.query("SELECT event_key FROM workflow_wakes WHERE workflow_id = ? AND message_id = ?").get(workflowId, messageId) as { event_key: string } | null
  const current = getWorkflow(workflowId)!
  const checkpoint = checkpointOf(current)
  if (wake) handled(checkpoint, wake.event_key)
  // the cancel restored the countdown this round came from: it is answered
  delete checkpoint.pending
  delete checkpoint.sendNow
  delete checkpoint.done
  db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1 WHERE id = ?", [JSON.stringify(checkpoint), workflowId])
  recordWorkflow(workflowId, "skipped", "A queued auto-fix round was cancelled", new Date().toISOString())
  announceWorkflow(row.task_id)
  return true
}
