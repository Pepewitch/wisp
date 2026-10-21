/**
 * When autopilot may act on a task: settled `done`, with nothing queued,
 * stopping, or still running in the background. Its own module so both the
 * loop and the round reservation can ask it, without an import cycle.
 */
import { isNetworkDetail } from "../adapters/network"
import { nextQueuedMessage, runningTurn } from "../store"
import { backgroundWork, processStopPending } from "../task-processes"
import { isTaskStopping } from "../turn-interrupt"
import type { Task } from "../types"

/** Nothing running, queued, stopping or left in the background. */
function settled(task: Task): boolean {
  return !task.archived && !runningTurn(task.id) && !nextQueuedMessage(task.id) &&
    !isTaskStopping(task.id) && !processStopPending(task.id) && backgroundWork(task.id).state === "none"
}

export function taskIsIdle(task: Task): boolean {
  return task.state === "done" && settled(task)
}

/** Settled on a turn that ended on the network (adapters/network.ts): autopilot may resume it (network.ts). */
export function taskIsNetworkPaused(task: Task): boolean {
  return task.state === "failed" && isNetworkDetail(task.state_detail) && settled(task)
}
