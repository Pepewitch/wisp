import type { ApiTask, TaskState } from "./types"

/**
 * A task that was running and no longer is. `task` is the row as it looked
 * when the change was observed, so the caller can name it and word its state
 * without another fetch.
 */
export interface TaskTransition {
  readonly task: ApiTask
  readonly from: TaskState
  readonly to: TaskState
}

/**
 * Only a turn that was running can finish. `creating → failed` is a setup
 * failure the person is usually still looking at, and a task that appears
 * already done was never something they were waiting on.
 */
const WATCHED_FROM: TaskState = "running"

export type TaskStateSnapshot = ReadonlyMap<string, TaskState>

export function snapshotTaskStates(
  tasks: readonly Pick<ApiTask, "id" | "state">[]
): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task.state]))
}

/**
 * Every task whose previous observation was `running` and whose current row
 * is anything else. Archived rows are skipped: archiving interrupts the turn,
 * and telling someone about a task they just put away is noise.
 */
export function finishedTransitions(
  previous: TaskStateSnapshot,
  tasks: readonly ApiTask[]
): TaskTransition[] {
  const transitions: TaskTransition[] = []
  for (const task of tasks) {
    const from = previous.get(task.id)
    if (from !== WATCHED_FROM || task.state === WATCHED_FROM || task.archived)
      continue
    transitions.push({ task, from, to: task.state })
  }
  return transitions
}

/**
 * Per-connection state memory that outlives any one React view. The active
 * tab and the inactive-tab monitors observe the same connection at different
 * times; keeping the snapshot here means a tab switch neither loses a change
 * nor re-announces one.
 */
export interface TaskTransitionTracker {
  /** Record the latest task list; the first observation only seeds. */
  observe(connectionId: string, tasks: readonly ApiTask[]): TaskTransition[]
  forget(connectionId: string): void
}

export function createTaskTransitionTracker(): TaskTransitionTracker {
  const snapshots = new Map<string, TaskStateSnapshot>()
  return {
    observe(connectionId, tasks) {
      const previous = snapshots.get(connectionId)
      snapshots.set(connectionId, snapshotTaskStates(tasks))
      return previous ? finishedTransitions(previous, tasks) : []
    },
    forget(connectionId) {
      snapshots.delete(connectionId)
    },
  }
}

export const taskTransitions = createTaskTransitionTracker()
