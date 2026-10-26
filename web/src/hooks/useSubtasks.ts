import { useQuery } from "@tanstack/react-query"

import { useLiveTasks } from "@/hooks/queries"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiSubtask, ApiTask } from "@/lib/types"

/**
 * GET /api/tasks/:id/subtasks: a parent's children, archived ones too, with
 * each one's clipped result and where its reports stand. The daemon
 * announces a child's change about the CHILD (a PR event moves a report
 * without touching any task row), so the events bridge refreshes this key
 * for every event about the parent or one of its children (lib/sse.ts).
 * Nothing polls.
 */
export function useSubtasks(taskId: string | null, enabled: boolean) {
  const { transport, qk } = useDaemonRuntime()
  return useQuery({
    queryKey: [...qk.task(taskId ?? ""), "subtasks"],
    queryFn: () => transport.request<ApiSubtask[]>(`/api/tasks/${taskId}/subtasks`),
    enabled: enabled && taskId !== null,
  })
}

/** How many unarchived subtasks the live list shows under `taskId`: the phone's tab strip shows Subtasks only then. */
export function useSubtaskCount(taskId: string | null): number {
  return useLiveTasks((tasks) => (taskId ? tasks.filter((task) => task.parent_task_id === taskId && !task.archived).length : 0)).data ?? 0
}

const NO_CHILDREN: ApiTask[] = []

/**
 * The unarchived subtasks the live list shows under `taskId`, in its order:
 * the summary card's Subtasks row counts and lists them. The live list is
 * already read for the sidebar, so this asks the daemon for nothing.
 */
export function useSubtaskChildren(taskId: string | null): ApiTask[] {
  return useLiveTasks((tasks) => (taskId ? tasks.filter((task) => task.parent_task_id === taskId && !task.archived) : NO_CHILDREN)).data ?? NO_CHILDREN
}
