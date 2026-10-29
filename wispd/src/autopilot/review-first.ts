/**
 * Whether auto-review goes before auto-fix on this look, and whether it
 * starts a round on the head without waiting for its checks. Auto-review
 * goes first while a round on the head runs (auto-fix then holds what it
 * would send, so a push does not end the round), when a round is about to
 * start, and when a settled rejection's findings are still to go out with
 * auto-fix's next round.
 *
 * Under repos[].reviewStart "ready" (the default) a round starts on its own
 * once the head is ready for review and has settled, alongside its checks,
 * unless auto-fix is about to send a CI fix (cheaper, and the round then
 * starts on the fixed head), the verification recipe holds this PR, or too
 * many of the PR's rounds ended without a verdict; then it waits for the
 * checks, as under "checks". Every fact here is read from the round rows or
 * the click itself, never from what an earlier look managed to save.
 */
import { reviewStartFor, type WispConfig } from "../config"
import type { Task } from "../types"
import { recipeActivatedAt, recipeVersion } from "../verify/recipe"
import { armReviewEpoch, latestPrRound, latestRound, reviewLedger, UNPRODUCTIVE_LIMIT, type RoundRow } from "../verify/rounds"
import { historySays, recordWorkflow, seenWake, type WorkflowRow } from "../workflows/store"
import { checksGate, FRESH_HEAD_MS } from "./gate"
import type { PrSnapshot } from "./github"
import { earlyWords, reviewNowLook } from "./review-now"
import type { AutopilotCheckpoint } from "./store"

export interface ReviewStart {
  /** the words a round reviewed whatever its checks say carries ("started on ready, checks still running"); null otherwise */
  early: string | null
  /** who starts a round this look would start: a person's Review now, or the head being ready; null: after its checks */
  by: "you" | "ready" | null
  /** auto-review goes before auto-fix on this look */
  first: boolean
}

const AFTER_CHECKS: ReviewStart = { early: null, by: null, first: false }

/**
 * A round's findings already went out, or a person said not to send them:
 * in an auto-fix round (reviewsSent, written with its wake), alone (the
 * `review:<id>` wake), or skipped as a CI key by an older daemon.
 */
export function reviewSent(rowId: string, checkpoint: AutopilotCheckpoint, roundId: string): boolean {
  return (checkpoint.reviewsSent ?? []).includes(roundId) || seenWake(rowId, `review:${roundId}`) || (checkpoint.skipped ?? []).includes(`review:${roundId}`)
}

/** A settled rejection (or a change the reviewers could not verify) whose findings have not gone out. */
export function unsentRejection(rowId: string, checkpoint: AutopilotCheckpoint, round: RoundRow | null): round is RoundRow {
  return round !== null && (round.state === "fail" || round.state === "inconclusive") && !reviewSent(rowId, checkpoint, round.id)
}

/** The recipe a recipe-held round failed on is still the one in force: no new version, and no activation since the round ended. */
export async function recipeStillHolds(repoPath: string, round: RoundRow): Promise<boolean> {
  const version = await recipeVersion(repoPath)
  const activatedAt = await recipeActivatedAt(repoPath)
  const activatedSince = activatedAt !== null && round.finished_at !== null && activatedAt > round.finished_at
  return !((version !== null && version !== round.recipe_version) || activatedSince)
}

export async function reviewStartLook(input: {
  row: WorkflowRow; task: Task; checkpoint: AutopilotCheckpoint; pr: PrSnapshot; required: ReadonlySet<string>; now: Date; cfg: WispConfig
  autoFix: boolean
  /** whether auto-fix sends a CI fix on this look (its round goes first), asked only when it can matter */
  ciReady: () => Promise<boolean>
}): Promise<ReviewStart> {
  const { row, checkpoint, pr } = input
  const nowMs = input.now.getTime()
  const words = reviewNowLook(row, checkpoint, pr, input.required, nowMs)
  if (words !== null) return { early: words, by: checkpoint.reviewNow === pr.head ? "you" : null, first: true }
  if (pr.isDraft) return AFTER_CHECKS
  const round = latestRound(row.id, pr.number, pr.head, pr.baseRefName)
  if (round?.state === "running" || (input.autoFix && unsentRejection(row.id, checkpoint, round))) return { early: null, by: null, first: true }
  // a round ended by a switch-off is no answer on its head: a fresh one starts
  if (round && round.state !== "superseded") return AFTER_CHECKS
  if (!await startsOnReady(input)) return AFTER_CHECKS
  const headFirstSeenMs = Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? ""))
  const checks = checksGate({ pr, requiredNames: input.required, nowMs, headFirstSeenMs })
  return { early: checks ? earlyWords("started on ready", checks) : null, by: "ready", first: true }
}

/** The project starts rounds on ready, and nothing holds this head back to its checks. */
async function startsOnReady(input: Parameters<typeof reviewStartLook>[0]): Promise<boolean> {
  const { row, task, checkpoint, pr, now } = input
  if (reviewStartFor(input.cfg, task.repo_path) !== "ready") return false
  // lookAt only gets here with the author idle: that, and the head's settling, is the debounce
  const headFirstSeenMs = Math.max(Date.parse(checkpoint.heads?.[pr.head] ?? ""), Date.parse(checkpoint.readySince ?? ""))
  if (!(now.getTime() - headFirstSeenMs >= FRESH_HEAD_MS) || await input.ciReady()) return false
  checkpoint.reviewArmedAt ??= armReviewEpoch(row.id, now.toISOString())
  const ledger = reviewLedger(row.id, pr.number, checkpoint.reviewArmedAt, checkpoint.reviewBase ?? 0)
  if (ledger.unproductive >= UNPRODUCTIVE_LIMIT) {
    // for the life of the PR: the rows keep saying so, whatever Resume does
    const said = `PR #${pr.number}: ${UNPRODUCTIVE_LIMIT} auto-review rounds ended without a verdict, so its rounds now wait for its checks`
    if (!historySays(row.id, said)) recordWorkflow(row.id, "review", said, now.toISOString(), null, { pr: pr.number, sha: pr.head })
    return false
  }
  const latest = latestPrRound(row.id, pr.number, checkpoint.reviewArmedAt)
  return !(latest?.state === "recipe" && await recipeStillHolds(task.repo_path, latest))
}
