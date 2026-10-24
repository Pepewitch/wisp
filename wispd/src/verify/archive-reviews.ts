/**
 * What archiving does to auto-review, written in the archive's own
 * transaction (domain/archive.ts) so a restart never finds a task archived
 * with its rounds still open, or the other way round.
 */
import type { TaskAuditActor } from "../task-audit"
import type { Task } from "../types"
import { recordWorkflow } from "../workflows/store"
import { endReview, reviewOfTask, supersedeRound } from "./reviews"
import { runningRounds } from "./rounds"

const short = (sha: string): string => sha.slice(0, 7)

/**
 * Every running round of an archived author ends, recorded on its history
 * the way any superseded round is. Its reviewers are archived in the same
 * batch, so nothing is left to retire afterwards.
 */
export function endRoundsOfArchived(authors: Task[], now: Date): void {
  const why = "the task was archived"
  for (const author of authors) {
    for (const round of runningRounds(author.id)) {
      supersedeRound(round.id, why, now)
      recordWorkflow(round.workflow_id, "review", `Round ${round.round} on ${short(round.head)} ended: ${why}`, now.toISOString(), null, { pr: round.pr, sha: round.head })
    }
  }
}

/**
 * A reviewer a person archived on its own: its review ends as an error the
 * round records. Auto-review retiring its own reviewer is not that.
 */
export function endReviewArchivedAlone(reviewer: Task, actor: TaskAuditActor, now: Date): void {
  if (actor === "autopilot") return
  const review = reviewOfTask(reviewer.id)
  if (review) endReview(review.id, "error", "archived by a person", now)
}
