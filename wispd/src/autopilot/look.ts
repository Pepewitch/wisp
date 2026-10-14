/**
 * Small pieces of one autopilot look (runtime.ts): what a look learns from
 * the PR, what it forgets when the task moves, and how it words a wait on the
 * task. Beside the runtime because that file is at its size limit.
 */
import type { PrSnapshot } from "./github"
import { trimHeads } from "./heads"
import type { AutopilotCheckpoint } from "./store"
import { backgroundWork } from "../task-processes"
import type { Task } from "../types"

export function busyReason(task: Task): string {
  switch (task.state) {
    case "needs-input": return "Waiting for your answer"
    case "failed": return "The task failed — waiting for you"
    case "stuck": return "The task is stuck — waiting for you"
    case "creating": return "Waiting for the task to start"
    case "running": return "Waiting for the task to finish"
    default: return backgroundWork(task.id).state !== "none" ? "Waiting for the task's background work" : "Waiting for the task to finish"
  }
}

/** What one look at an open, unqueued PR teaches the checkpoint. */
export function observe(checkpoint: AutopilotCheckpoint, pr: PrSnapshot, now: Date): void {
  // A merge attempt no longer being confirmed did not land (or a merge queue
  // ejected it): forget it, so a later merge by someone else is not Wisp's.
  if (checkpoint.mergeAttempt && checkpoint.state !== "merging") delete checkpoint.mergeAttempt
  checkpoint.heads = trimHeads({ ...checkpoint.heads, [pr.head]: checkpoint.heads?.[pr.head] ?? now.toISOString() }, pr.head)
  // A draft marked ready queues new CI; its draft-time results prove nothing.
  if (pr.isDraft) delete checkpoint.readySince
  else checkpoint.readySince ??= now.toISOString()
}

export function forgetPending(checkpoint: AutopilotCheckpoint): void {
  delete checkpoint.pending
  delete checkpoint.sendNow
}

/** The task is busy, or a round went out: the next delay starts from its next idle moment. */
export function forgetIdle(checkpoint: AutopilotCheckpoint): void {
  delete checkpoint.idleSince
  delete checkpoint.idleTurn
  forgetPending(checkpoint)
}

/** The PR's latest sign of life: its head appearing or going green, a round going out, or a review or comment anyone can see. */
export function lastActivity(pr: PrSnapshot, checkpoint: AutopilotCheckpoint): number {
  const seen = (comment: { hidden: boolean }) => !comment.hidden
  const times = [
    checkpoint.heads?.[pr.head], checkpoint.lastRoundAt, checkpoint.greenHead === pr.head ? checkpoint.greenAt : undefined,
    ...pr.reviews.filter((review) => review.state !== "PENDING").map((review) => review.editedAt ?? review.submittedAt),
    ...pr.comments.filter(seen).map((comment) => comment.editedAt ?? comment.createdAt),
    ...pr.threads.flatMap((thread) => thread.comments.filter(seen).map((comment) => comment.editedAt ?? comment.createdAt)),
  ]
  return Math.max(0, ...times.map((time) => Date.parse(time ?? "")).filter(Number.isFinite))
}

/** Waiting on the task or for its next PR, after one merged: the status keeps saying which merged. */
export function nextPrReason(merged: NonNullable<AutopilotCheckpoint["lastMerged"]>, reason: string): string {
  return `#${merged.pr} ${merged.byWisp ? "merged by Wisp" : "merged"} · ${reason === "Waiting for a PR" ? "Waiting for the task's next PR" : reason}`
}
