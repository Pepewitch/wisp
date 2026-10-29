/**
 * Review now: a person steering by hand asks auto-review for a round on the
 * PR's current head without waiting for its checks to settle, or for an
 * auto-fix countdown ahead of it. It is one click for one head, never a
 * setting: a push between the click and the look cancels it.
 *
 * The merge gate is untouched. A round that passes early still waits for the
 * checks before anything merges, because mergeGate (gate.ts) runs the checks
 * gate first; and the round counts toward the PR's review budget like any other.
 */
import type { AutopilotStatus } from "../../../shared/autopilot"
import { db } from "../store-database"
import { latestHead } from "../subtask-reports"
import { latestRound } from "../verify/rounds"
import { announceWorkflow, recordWorkflow, type WorkflowRow } from "../workflows/store"
import { checksGate } from "./gate"
import type { PrSnapshot } from "./github"
import { AutopilotError, autopilotRow, autopilotStatus, checkpointOf, paramsOf, type AutopilotCheck, type AutopilotCheckpoint } from "./store"

const short = (sha: string): string => sha.slice(0, 7)

/** Any round on this head that was not ended by a switch-off or a retarget: Resume, not Review now, asks it again. */
function roundOnHead(workflowId: string, pr: number, head: string): boolean {
  return db.query("SELECT 1 FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND head = ? AND state != 'superseded' LIMIT 1").get(workflowId, pr, head) !== null
}

/** POST …/autopilot/review-now: remember the head the person saw (`head`, or the latest one Wisp read); the next look starts its round. */
export function askReviewNow(taskId: string, head: string | undefined, now = new Date()): AutopilotStatus {
  const row = autopilotRow(taskId)
  if (!row || !paramsOf(row).autoReview) throw new AutopilotError("Auto-review is not on for this task", 409)
  if (row.state !== "active") throw new AutopilotError("Autopilot is paused — resume it first", 409)
  const checkpoint = checkpointOf(row)
  const current = latestHead(checkpoint.heads)
  if (!checkpoint.pr || !current) throw new AutopilotError("Auto-review has no pull request head to review yet", 409)
  const seen = head ?? current
  if (seen !== current) throw new AutopilotError(`PR #${checkpoint.pr} has a newer head (${short(current)}) — look again before reviewing it`, 409)
  if (!checkpoint.readySince) throw new AutopilotError(`PR #${checkpoint.pr} is a draft — auto-review starts once it is ready for review`, 409)
  if (roundOnHead(row.id, checkpoint.pr, seen)) throw new AutopilotError(`Auto-review already has a round on ${short(seen)} — Resume reviews it again`, 409)
  if (checkpoint.reviewNow !== seen) {
    const at = now.toISOString()
    // the revision bump makes a look already in flight discard its answer, as Send now's does
    db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify({ ...checkpoint, reviewNow: seen }), at, at, row.id])
    recordWorkflow(row.id, "review", `Review now: you asked for a round on ${short(seen)} without waiting for its checks`, at, null, { pr: checkpoint.pr, sha: seen })
    announceWorkflow(taskId)
  }
  return autopilotStatus(taskId)
}

/**
 * Before auto-fix, once the PR is read: forget a click a push or a draft made
 * moot, or one a round already on this head answers; note whether this head
 * has no round yet and its checks hold auto-review (what offers Review now);
 * and say whether this look reviews early. Returns the words its round's
 * status carries ("started by you, checks still running"), or null.
 */
export function reviewNowLook(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, required: ReadonlySet<string>, nowMs: number): string | null {
  if (checkpoint.reviewNow !== pr.head || pr.isDraft) delete checkpoint.reviewNow
  if (checkpoint.reviewEarly !== pr.head) delete checkpoint.reviewEarly
  const round = latestRound(row.id, pr.number, pr.head, pr.baseRefName)
  if (round) delete checkpoint.reviewNow
  const headFirstSeenMs = Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? ""))
  const checks = checksGate({ pr, requiredNames: required, nowMs, headFirstSeenMs })
  if (!round && !pr.isDraft) checkpoint.reviewOpen = { head: pr.head, checks: checks !== null }
  if (checkpoint.reviewNow === undefined && checkpoint.reviewEarly === undefined) return null
  if (!checks) return "started by you"
  return `started by you, ${checks.kind === "needs-you" ? `${checks.reason.charAt(0).toLowerCase()}${checks.reason.slice(1)}` : "checks still running"}`
}

/**
 * A look that reviews early: auto-review goes first and auto-fix after it,
 * each keeping its words here, and the look saves one answer. Auto-review's
 * words stand, with the sooner of the two waits so an auto-fix countdown
 * still goes out on time; auto-fix's stand once auto-review has nothing to
 * say (its round passed).
 */
export class EarlyAnswers {
  private review: AutopilotCheck | null = null
  private fix: AutopilotCheck | null = null
  readonly onReview = (check: AutopilotCheck): void => { this.review = check }
  readonly onFix = (check: AutopilotCheck): void => { this.fix = check }

  /** True when the look ends here, its answer saved; false when the head passed and auto-fix had nothing to do: the merge gate goes on. */
  finish(passed: boolean, nothingToFix: string | null, save: (check: AutopilotCheck) => boolean): boolean {
    if (passed && nothingToFix !== null) return false
    const { review, fix } = this
    const answer = review && fix ? { ...review, delayMs: Math.min(review.delayMs, fix.delayMs) } : review ?? fix
    if (answer) save(answer)
    return true
  }
}
