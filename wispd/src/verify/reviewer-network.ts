/**
 * A reviewer whose turn ended on the network (#411): the same pause autopilot
 * gives a task of its own (autopilot/network.ts), for a reviewer task, which
 * has no autopilot of its own. After the same backoff from the turn's end it
 * gets one "continue" message, at most NETWORK_RESUMES times per review, all
 * inside the round's time limit (the caller checks it first). The resumes
 * come before the review's one verdict nudge and before any fallback agent:
 * only once they are spent does the failure end the review or hand it over.
 */
import { isNetworkDetail } from "../adapters/network"
import type { AdapterDef } from "../adapters"
import { NETWORK_BACKOFF_MS, NETWORK_RESUME_MESSAGE, NETWORK_RESUMES } from "../autopilot/network"
import type { WispConfig } from "../config"
import { startNextQueuedMessage } from "../runner"
import { createTaskMessage, latestTurnForTask, messagesFor, randomId } from "../store"
import type { Task, TaskMessage } from "../types"

export type ReviewerResumePlan =
  /** not a network failure, or its resumes are spent */
  | { kind: "none" }
  /** resume number `resume` (from 1) is due at `at`, epoch ms */
  | { kind: "wait"; resume: number; at: number }
  /** send resume number `resume` now; `queued` names one already sent that has not started yet */
  | { kind: "resume"; resume: number; queued: string | null }

function isNetworkResume(message: TaskMessage): boolean {
  try {
    return (JSON.parse(message.source_json ?? "null") as { kind?: unknown } | null)?.kind === "network-resume"
  } catch {
    return false
  }
}

/** What to do about a reviewer task resting on a failed turn. */
export function planReviewerResume(reviewer: Task, now: number): ReviewerResumePlan {
  if (reviewer.state !== "failed" || !isNetworkDetail(reviewer.state_detail)) return { kind: "none" }
  const resumes = messagesFor(reviewer.id).filter(isNetworkResume)
  // sent, but its turn has not started (no free slot then): start that one, never a second
  const queued = resumes.find((message) => message.status === "queued")
  if (queued) return { kind: "resume", resume: resumes.length, queued: queued.id }
  if (resumes.length >= NETWORK_RESUMES) return { kind: "none" }
  const ended = Date.parse(latestTurnForTask(reviewer.id)?.ended_at ?? "")
  const at = (Number.isFinite(ended) ? ended : now) + NETWORK_BACKOFF_MS[resumes.length]!
  return now < at ? { kind: "wait", resume: resumes.length + 1, at } : { kind: "resume", resume: resumes.length + 1, queued: null }
}

/** Send (or start again) the message that resumes the reviewer. */
export function resumeReviewer(
  reviewer: Task, queued: string | null, source: { pr: number | null; round: number | null },
  adapters: Record<string, AdapterDef>, cfg: WispConfig,
): void {
  let id = queued
  if (!id) {
    id = randomId("m", 12)
    createTaskMessage({
      id, taskId: reviewer.id, text: NETWORK_RESUME_MESSAGE, attachmentHash: "", origin: "workflow",
      source: { by: "autopilot", kind: "network-resume", pr: source.pr, round: source.round, rounds: null },
    })
  }
  startNextQueuedMessage(reviewer.id, adapters, cfg, id)
}

export { NETWORK_RESUMES as REVIEWER_NETWORK_RESUMES }
