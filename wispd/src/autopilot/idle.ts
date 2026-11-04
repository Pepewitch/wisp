/**
 * When autopilot may act on a task: settled `done`, with nothing queued,
 * stopping, or still running in the background. Its own module so both the
 * loop and the round reservation can ask it, without an import cycle.
 */
import { isNetworkDetail } from "../adapters/network"
import { db, nextQueuedMessage, runningTurn } from "../store"
import { backgroundWork, processStopPending } from "../task-processes"
import { isTaskStopping } from "../turn-interrupt"
import type { Task } from "../types"

/** How long a parent's background work may hold a waiting subtask report back (#517). */
export const REPORT_BACKGROUND_HOLD_MS = 5 * 60_000

/** Nothing running, queued or stopping; background work aside. */
function quiet(task: Task): boolean {
  return !task.archived && !runningTurn(task.id) && !nextQueuedMessage(task.id) &&
    !isTaskStopping(task.id) && !processStopPending(task.id)
}

/** Nothing running, queued, stopping or left in the background. */
function settled(task: Task): boolean {
  return quiet(task) && backgroundWork(task.id).state === "none"
}

/** When the parent's oldest waiting subtask report was recorded, epoch ms; null when none waits. */
function oldestReportWaiting(taskId: string): number | null {
  const row = db.query(`SELECT MIN(at) AS at FROM (
    SELECT created_at AS at FROM subtask_reports WHERE parent_task_id = ? AND state IN ('pending', 'queued')
    UNION ALL SELECT created_at AS at FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued')`)
    .get(taskId, taskId) as { at: string | null } | null
  const at = Date.parse(row?.at ?? "")
  return Number.isFinite(at) ? at : null
}

/** When the parent's latest turn ended, epoch ms; null while one runs or before any. */
function lastTurnEnded(taskId: string): number | null {
  const row = db.query("SELECT ended_at FROM turns WHERE task_id = ? ORDER BY n DESC LIMIT 1").get(taskId) as { ended_at: string | null } | null
  const at = Date.parse(row?.ended_at ?? "")
  return Number.isFinite(at) ? at : null
}

/**
 * Whether the parent's background work still holds its subtask reports back.
 * The agent will wake when that work finishes, so a report waits to go with
 * it, but only for REPORT_BACKGROUND_HOLD_MS, counted from the later of the
 * oldest waiting report and the parent's last turn end (the time it has been
 * waiting on background work alone): a parent that always keeps something
 * running (a background `wisp wait` for its subtasks, a dev server) would
 * otherwise never get one (#517). The report then goes as the person's
 * messages do, into the harness's live process when one is kept for that
 * work. Background work Wisp cannot read (`unknown`) is held the same way.
 */
export function backgroundHoldsReport(taskId: string, now = Date.now()): boolean {
  if (backgroundWork(taskId).state === "none") return false
  const oldest = oldestReportWaiting(taskId)
  if (oldest === null) return true
  const since = Math.max(oldest, lastTurnEnded(taskId) ?? oldest)
  return now - since < REPORT_BACKGROUND_HOLD_MS
}

/** A subtask report not yet read: recorded and waiting for delivery, or queued to start. */
function reportWaiting(taskId: string): boolean {
  return db.query("SELECT 1 FROM subtask_reports WHERE parent_task_id = ? AND state IN ('pending', 'queued')").get(taskId) !== null ||
    db.query("SELECT 1 FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued'").get(taskId) !== null
}

/**
 * Idle for autopilot: never while a subtask report waits, so it does not
 * merge or plan around evidence nobody read. `reports: "ignore"` asks only
 * whether the task's own work is settled, for what reports must not hold up
 * (a Stop hold clearing after the person's next turn: reports wait for it).
 */
export function taskIsIdle(task: Task, reports: "count" | "ignore" = "count"): boolean {
  return task.state === "done" && settled(task) && (reports === "ignore" || !reportWaiting(task.id))
}

/**
 * Free to take a subtask report: settled after a turn that ended done or
 * failed, not waiting on the person, and not held by its background work
 * (backgroundHoldsReport).
 */
export function canTakeReport(task: Task, now = Date.now()): boolean {
  return (task.state === "done" || task.state === "failed") && !task.purge_pending && quiet(task) && !backgroundHoldsReport(task.id, now)
}

/** Settled on a turn that ended on the network (adapters/network.ts): autopilot may resume it (network.ts). */
export function taskIsNetworkPaused(task: Task): boolean {
  return task.state === "failed" && isNetworkDetail(task.state_detail) && settled(task)
}
