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

/** Nothing running, queued, stopping or left in the background. */
function settled(task: Task): boolean {
  return !task.archived && !runningTurn(task.id) && !nextQueuedMessage(task.id) &&
    !isTaskStopping(task.id) && !processStopPending(task.id) && backgroundWork(task.id).state === "none"
}

/** A subtask report waiting to start: the parent has unread evidence. */
function reportWaiting(taskId: string): boolean {
  return db.query("SELECT 1 FROM task_messages WHERE task_id = ? AND origin = 'subtask' AND status = 'queued'").get(taskId) !== null
}

/** Idle for autopilot: never while a subtask report waits, so it does not merge or plan around evidence nobody read. */
export function taskIsIdle(task: Task): boolean {
  return task.state === "done" && settled(task) && !reportWaiting(task.id)
}

/** Free to take a subtask report: settled after a turn that ended done or failed, and not waiting on the person. */
export function canTakeReport(task: Task): boolean {
  return (task.state === "done" || task.state === "failed") && !task.purge_pending && settled(task)
}

/** Settled on a turn that ended on the network (adapters/network.ts): autopilot may resume it (network.ts). */
export function taskIsNetworkPaused(task: Task): boolean {
  return task.state === "failed" && isNetworkDetail(task.state_detail) && settled(task)
}
