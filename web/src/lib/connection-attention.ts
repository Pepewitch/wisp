import { pausedOnNetwork } from "./state"
import type { ApiTask, TaskState } from "./types"

export type ConnectionAttention = Exclude<TaskState, "done"> | null

const ATTENTION_PRIORITY: readonly Exclude<TaskState, "done">[] = [
  "needs-input",
  "stuck",
  "failed",
  "running",
  "creating",
  "queued",
]

/**
 * The highest-priority live task state worth showing on an inactive
 * connection. A task paused on the network (stateWord's "Paused · network")
 * needs nobody: autopilot resumes it, so it is not shown as failed.
 */
export function connectionAttention(
  tasks: readonly Pick<ApiTask, "state" | "archived" | "autopilot">[]
): ConnectionAttention {
  const states = new Set(
    tasks.filter((task) => !task.archived && !pausedOnNetwork(task)).map((task) => task.state)
  )
  return ATTENTION_PRIORITY.find((state) => states.has(state)) ?? null
}
