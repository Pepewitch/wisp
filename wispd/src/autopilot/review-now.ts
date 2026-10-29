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
import { armReviewEpoch, latestRound } from "../verify/rounds"
import { announceWorkflow, recordWorkflow, type WorkflowRow } from "../workflows/store"
import { checksGate, type GateResult } from "./gate"
import type { PrSnapshot } from "./github"
import { AutopilotError, autopilotRow, autopilotStatus, checkpointOf, paramsOf, type AutopilotCheck, type AutopilotCheckpoint } from "./store"

const short = (sha: string): string => sha.slice(0, 7)

/**
 * A round on this head and base that was not ended by a switch-off or a
 * retarget: Resume, not Review now, asks it again. The base is the one the
 * last look offered Review now on, so the offer and the click agree; with no
 * offer to go by, a round on any base refuses.
 */
function roundOnHead(workflowId: string, pr: number, head: string, base: string | undefined): boolean {
  if (base !== undefined) {
    const latest = latestRound(workflowId, pr, head, base)
    return latest !== null && latest.state !== "superseded"
  }
  return db.query("SELECT 1 FROM auto_review_rounds WHERE workflow_id = ? AND pr = ? AND head = ? AND state != 'superseded' LIMIT 1").get(workflowId, pr, head) !== null
}

/** POST …/autopilot/review-now: remember the head the person saw (`head`, or the latest one Wisp read); the next look starts its round. */
export function askReviewNow(taskId: string, head: string | undefined, now = new Date()): { status: AutopilotStatus; asked: boolean } {
  const row = autopilotRow(taskId)
  if (!row || !paramsOf(row).autoReview) throw new AutopilotError("Auto-review is not on for this task", 409)
  if (row.state !== "active") throw new AutopilotError("Autopilot is paused — resume it first", 409)
  const checkpoint = checkpointOf(row)
  // the round this click starts is counted from a stored epoch, whatever becomes of the look that starts it
  checkpoint.reviewArmedAt ??= armReviewEpoch(row.id, now.toISOString())
  const current = latestHead(checkpoint.heads)
  if (!checkpoint.pr || !current) throw new AutopilotError("Auto-review has no pull request head to review yet", 409)
  const seen = head ?? current
  if (seen !== current) throw new AutopilotError(`PR #${checkpoint.pr} has a newer head (${short(current)}) — look again before reviewing it`, 409)
  if (!checkpoint.readySince) throw new AutopilotError(`PR #${checkpoint.pr} is a draft — auto-review starts once it is ready for review`, 409)
  const offered = checkpoint.reviewOpen?.head === seen ? checkpoint.reviewOpen.base : undefined
  if (roundOnHead(row.id, checkpoint.pr, seen, offered)) throw new AutopilotError(`Auto-review already has a round on ${short(seen)} — Resume reviews it again`, 409)
  const asked = checkpoint.reviewNow !== seen
  if (asked) {
    const at = now.toISOString()
    // the revision bump makes a look already in flight discard its answer, as Send now's does
    db.run("UPDATE workflows SET checkpoint_json = ?, revision = revision + 1, next_check_at = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify({ ...checkpoint, reviewNow: seen }), at, at, row.id])
    recordWorkflow(row.id, "review", `Review now: you asked for a round on ${short(seen)} without waiting for its checks`, at, null, { pr: checkpoint.pr, sha: seen })
    announceWorkflow(taskId)
  }
  return { status: autopilotStatus(taskId), asked }
}

/**
 * Before auto-fix, once the PR is read: forget a click a push or a draft made
 * moot, or one a round on this head answers; note whether this head has no
 * round yet and its checks hold auto-review (what offers Review now); and say
 * whether this look reviews early. Returns the words its round's status
 * carries ("started by you, checks still running"), or null.
 *
 * Once a round on the head exists its row decides (`early`, written with the
 * round), so dropping the click here never strands the round behind the
 * checks, whatever the look that started it managed to save.
 */
export function reviewNowLook(row: WorkflowRow, checkpoint: AutopilotCheckpoint, pr: PrSnapshot, required: ReadonlySet<string>, nowMs: number): string | null {
  const latest = pr.isDraft ? null : latestRound(row.id, pr.number, pr.head, pr.baseRefName)
  // a round ended by a switch-off is no answer: askReviewNow accepts a click over one
  const round = latest?.state === "superseded" ? null : latest
  if (checkpoint.reviewNow !== pr.head || pr.isDraft || round) delete checkpoint.reviewNow
  const headFirstSeenMs = Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? ""))
  const checks = checksGate({ pr, requiredNames: required, nowMs, headFirstSeenMs })
  if (!round && !pr.isDraft) checkpoint.reviewOpen = { head: pr.head, base: pr.baseRefName, checks: checks !== null }
  if (round ? !round.early : checkpoint.reviewNow === undefined) return null
  return earlyWords(round?.early === 2 ? "started on ready" : "started by you", checks)
}

/** A round reviewed whatever its checks say: who started it, and what its checks were doing ("started by you, checks still running"). */
export function earlyWords(who: string, checks: GateResult | null): string {
  if (!checks) return who
  return `${who}, ${checks.kind === "needs-you" ? `${checks.reason.charAt(0).toLowerCase()}${checks.reason.slice(1)}` : "checks still running"}`
}

/**
 * A look where auto-review goes first (review-first.ts) and auto-fix after
 * it, each keeping its words here, and the look saves one answer. With both
 * speaking, auto-review's words lead and auto-fix's follow ("… · Auto-fix
 * will send after the review: …"), with the sooner of the two waits so an
 * auto-fix countdown still goes out on time. Auto-fix's stand alone once
 * auto-review has nothing to say (its round passed), or once auto-review
 * handed it a rejection to send (`deferred`).
 */
export class EarlyAnswers {
  private review: AutopilotCheck | null = null
  private fix: AutopilotCheck | null = null
  readonly onReview = (check: AutopilotCheck): void => { this.review = check }
  readonly onFix = (check: AutopilotCheck): void => { this.fix = check }

  /** True when the look ends here, its answer saved; false when the head passed and auto-fix had nothing to do: the merge gate goes on. */
  finish(passed: boolean, nothingToFix: string | null, save: (check: AutopilotCheck) => boolean, deferred = false): boolean {
    if (passed && nothingToFix !== null) return false
    const { review, fix } = this
    const answer = deferred && fix ? fix
      : review && fix ? { ...review, reason: `${review.reason} · ${fix.reason}`, delayMs: Math.min(review.delayMs, fix.delayMs) }
      : review ?? fix
    if (answer) save(answer)
    return true
  }
}
