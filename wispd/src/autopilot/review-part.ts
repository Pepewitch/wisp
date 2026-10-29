/**
 * Auto-review's part of an auto-fix round. While a round on the head runs,
 * auto-fix holds what it would send, so no push of Wisp's ends it; once the
 * round rejects the head, its findings go out with whatever else auto-fix
 * holds: one message, one push. Beside runtime.ts because that file is at its
 * size limit.
 */
import type { AutopilotState } from "../../../shared/autopilot"
import type { AdapterDef } from "../adapters"
import { removeMessageAttachments } from "../attachments"
import type { Task } from "../types"
import { budgetWords, latestRound, type RoundRow } from "../verify/rounds"
import type { WorkflowRow } from "../workflows/store"
import { bounceImages, reviewFindingsLines, spentNow, writeReviewFeedback } from "./auto-review"
import { BUSY_MS } from "./cadence"
import { autoFixAtCap } from "./fix-plan"
import type { PrSnapshot } from "./github"
import { unsentRejection } from "./review-first"
import type { AutopilotCheckpoint } from "./store"

/** A round on the head still runs: auto-fix holds what it would send until it settles. */
export function reviewRunning(rowId: string, pr: PrSnapshot): boolean {
  return latestRound(rowId, pr.number, pr.head, pr.baseRefName)?.state === "running"
}

/**
 * The head's settled rejection that auto-fix's next round carries: its
 * findings not sent yet, and auto-fix with a round left. At its cap, bounce
 * (auto-review.ts) sends them alone instead, before auto-fix may pause.
 */
export function reviewToCarry(rowId: string, checkpoint: AutopilotCheckpoint, pr: PrSnapshot): RoundRow | null {
  if (autoFixAtCap(checkpoint)) return null
  const round = latestRound(rowId, pr.number, pr.head, pr.baseRefName)
  return unsentRejection(rowId, checkpoint, round) ? round : null
}

/** The review part of a round's evidence key, beside `ci…` and `fb:…` (feedback.ts keyParts). */
export const reviewKey = (round: RoundRow): string => `rv:${round.id}`

/** Hold the round auto-fix would send: Send now and Skip act on it as on a countdown, and it goes once the review settles. */
export function holdForReview(
  checkpoint: AutopilotCheckpoint, key: string, summary: string, now: Date, say: (state: AutopilotState, reason: string, delayMs: number) => null,
): null {
  const sendsAt = checkpoint.pending?.key === key ? checkpoint.pending.sendsAt : now.toISOString()
  checkpoint.pending = { key, summary, sendsAt, afterReview: true }
  return say("waiting", `Auto-fix will send after the review: ${summary}`, BUSY_MS)
}

export interface ReviewFiles {
  /** the message's review part, rendered before CI and feedback */
  lines: string[]
  /** where the budget stands, for the round's history entry */
  words: string
  attachments?: { json: string; hash: string }
  /** remove the stored images: the round was not reserved */
  discard(): void
}

/**
 * The review part's files: the reviewers' images stored under the round's
 * message id, then the findings file that names any that could not travel.
 * Built after every await of the round's, so nothing between here and its
 * reservation can leave the images behind.
 */
export function reviewFiles(
  adapters: Record<string, AdapterDef>, look: { task: Task; row: WorkflowRow; checkpoint: AutopilotCheckpoint; pr: PrSnapshot }, round: RoundRow, messageId: string,
): ReviewFiles {
  const words = budgetWords(round.round, spentNow(look))
  const images = bounceImages(adapters, look.task, round, messageId)
  const discard = (): void => removeMessageAttachments(look.task.id, messageId)
  let file: string
  try {
    file = writeReviewFeedback(look.task, look.row, round, images.skipped)
  } catch (error) {
    discard()
    throw error
  }
  return {
    words, discard,
    lines: [`Auto-review, ${words}, head ${round.head.slice(0, 7)}:`, ...reviewFindingsLines(round, file, images.count)],
    attachments: images.json ? { json: images.json, hash: images.hash } : undefined,
  }
}

/** Reserve the round, and remove the review's images whichever way it does not happen. */
export function reserveWith(files: ReviewFiles | null, reserve: () => string | null): string | null {
  let id: string | null = null
  try {
    id = reserve()
  } finally {
    if (!id) files?.discard()
  }
  return id
}
