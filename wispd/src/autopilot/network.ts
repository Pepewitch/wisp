/**
 * Autopilot's answer to a turn that ended on the network (adapters/network.ts
 * gives the task its `network: ` detail): a pause, not a failure. The harness
 * session and the worktree survive an outage, so the task only needs telling
 * to go on. A bounded backoff from the turn's end — 1, 2, then 4 minutes —
 * and Wisp sends it one workflow message to continue, at most three in a row.
 * A turn that ends any other way starts the count over; past the third, the
 * task waits for a person like any failed task. Never for any other failure:
 * an auth, quota or limit error, or a real one, is never retried.
 *
 * Only for tasks under autopilot (any of its switches on): its loop is what
 * looks at a settled task again, and its rows hold the count.
 */
import { isNetworkDetail } from "../adapters/network"
import { getTaskMessage, latestTurnForTask, newTaskMessageId } from "../store"
import type { Task, Turn } from "../types"
import { seenWake, type WorkflowRow } from "../workflows/store"
import { MOVING_MS } from "./cadence"
import { taskIsNetworkPaused } from "./idle"
import { reserveRound, type AutopilotCheckpoint } from "./store"

/** The wait before each resume in a row, from the end of the turn that dropped. */
export const NETWORK_BACKOFF_MS = [60_000, 2 * 60_000, 4 * 60_000] as const
export const NETWORK_RESUMES = NETWORK_BACKOFF_MS.length
export const NETWORK_RESUME_MESSAGE = "The network dropped; continue from where you stopped."

export type NetworkPlan =
  /** not a turn autopilot resumes (or a person cancelled its resume): the look goes on as before */
  | { kind: "none" }
  /** the resumes in a row are spent: the task waits for a person */
  | { kind: "spent" }
  /** resume number `resume` (from 1) is due at `at`, epoch ms */
  | { kind: "wait"; resume: number; at: number }
  /** send resume number `resume` now, under this once-only key */
  | { kind: "resume"; resume: number; key: string }

/**
 * How many automatic resumes in a row led to `turn`: the count stands only
 * when the last resume's message is what started it. A person's message, or
 * a turn that settled any other way since, starts the count over.
 */
export function resumesBefore(turn: Turn, checkpoint: AutopilotCheckpoint): number {
  const last = checkpoint.network
  if (!last) return 0
  return getTaskMessage(last.messageId)?.turn_n === turn.n ? last.resumes : 0
}

/**
 * What to do about a task resting on a failed turn, the caller having checked
 * that the task is paused on the network (idle.ts taskIsNetworkPaused).
 * `handled` says whether a resume for that turn already went out, or was
 * cancelled by a person, which is declining it.
 */
export function planNetworkResume(input: { turn: Turn | null; turnCount: number; resumes: number; handled: (key: string) => boolean; now: number }): NetworkPlan {
  const { turn } = input
  if (!turn || turn.status !== "failed" || turn.n !== input.turnCount) return { kind: "none" }
  const key = `network:${turn.n}`
  if (input.handled(key)) return { kind: "none" }
  if (input.resumes >= NETWORK_RESUMES) return { kind: "spent" }
  const resume = input.resumes + 1
  const ended = Date.parse(turn.ended_at ?? "")
  const at = (Number.isFinite(ended) ? ended : input.now) + NETWORK_BACKOFF_MS[input.resumes]!
  return input.now < at ? { kind: "wait", resume, at } : { kind: "resume", resume, key }
}

/** "The network dropped — resuming in 2 min (2 of 3)" */
export function networkWaitReason(plan: { resume: number; at: number }, now: number): string {
  const minutes = Math.max(1, Math.ceil((plan.at - now) / 60_000))
  return `The network dropped — resuming in ${minutes} min (${plan.resume} of ${NETWORK_RESUMES})`
}

/** A task event that starts a countdown to a resume: its turn just ended on the network. */
export function droppedOnNetwork(state: string, task: Task | null): boolean {
  return state === "failed" && isNetworkDetail(task?.state_detail ?? null)
}

export interface NetworkLookDeps {
  now: Date
  hasSlot: (task: Task) => boolean
  /** save this look: waiting, for this reason, and look again in `delayMs` */
  say: (reason: string, delayMs: number) => void
  /** start the reserved message's turn */
  start: (messageId: string) => void
}

/**
 * One autopilot look at a task resting on a turn that ended on the network:
 * wait out its backoff, then reserve and start the one message that resumes
 * it. False when that is not the task's situation, or its resumes are spent:
 * the look goes on as before, and a spent task reads "failed — waiting for you".
 */
export function networkLook(row: WorkflowRow, task: Task, checkpoint: AutopilotCheckpoint, deps: NetworkLookDeps): boolean {
  delete checkpoint.networkWait
  if (!taskIsNetworkPaused(task)) return false
  const now = deps.now.getTime()
  const turn = latestTurnForTask(task.id)
  const plan = planNetworkResume({
    turn, turnCount: task.turn_count, resumes: turn ? resumesBefore(turn, checkpoint) : 0, now,
    handled: (key) => seenWake(row.id, key) || (checkpoint.skipped ?? []).includes(key),
  })
  if (plan.kind === "none" || plan.kind === "spent") return false
  const wait = (at: number) => { checkpoint.networkWait = { turn: task.turn_count, resume: plan.resume, of: NETWORK_RESUMES, at: new Date(at).toISOString() } }
  if (plan.kind === "wait") {
    wait(plan.at)
    deps.say(networkWaitReason(plan, now), plan.at - now)
    return true
  }
  if (!deps.hasSlot(task)) {
    wait(now)
    deps.say("The network dropped — resuming once a task slot is free", MOVING_MS)
    return true
  }
  const messageId = newTaskMessageId()
  const id = reserveRound(row, {
    key: plan.key, prompt: NETWORK_RESUME_MESSAGE, reason: `Resumed after the network dropped (${plan.resume} of ${NETWORK_RESUMES})`,
    checkpoint: { ...checkpoint, network: { messageId, resumes: plan.resume } }, turnCount: task.turn_count, messageId,
    ready: taskIsNetworkPaused, about: "task", by: checkpoint.by,
  }, deps.now)
  if (id) deps.start(id)
  return true
}
