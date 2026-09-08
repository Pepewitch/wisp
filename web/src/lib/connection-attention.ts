import type { ApiTask, TaskState } from "./types"

export type ConnectionAttention = Exclude<TaskState, "done"> | null

const ATTENTION_PRIORITY: readonly Exclude<TaskState, "done">[] = [
  "needs-input",
  "stuck",
  "failed",
  "running",
  "creating",
]

/** The highest-priority live task state worth showing on an inactive connection. */
export function connectionAttention(
  tasks: readonly Pick<ApiTask, "state" | "archived">[]
): ConnectionAttention {
  const states = new Set(
    tasks.filter((task) => !task.archived).map((task) => task.state)
  )
  return ATTENTION_PRIORITY.find((state) => states.has(state)) ?? null
}
