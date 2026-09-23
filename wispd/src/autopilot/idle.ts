/**
 * When autopilot may act on a task: settled `done`, with nothing queued,
 * stopping, or still running in the background. Its own module so both the
 * loop and the round reservation can ask it, without an import cycle.
 */
import { nextQueuedMessage, runningTurn } from "../store"
import { backgroundWork, processStopPending } from "../task-processes"
import { isTaskStopping } from "../turn-interrupt"
import type { Task } from "../types"

export function taskIsIdle(task: Task): boolean {
  return task.state === "done" && !task.archived && !runningTurn(task.id) && !nextQueuedMessage(task.id) &&
    !isTaskStopping(task.id) && !processStopPending(task.id) && backgroundWork(task.id).state === "none"
}
