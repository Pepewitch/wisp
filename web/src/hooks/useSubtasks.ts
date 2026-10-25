import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"

import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiSubtask, ApiTask } from "@/lib/types"

/** The live list's word on a family: the parent and each child's state and last change. */
function familyStamp(tasks: ApiTask[], parentId: string | null): string {
  return tasks
    .filter((task) => task.id === parentId || task.parent_task_id === parentId)
    .map((task) => `${task.id}:${task.state}:${task.updated_at}`)
    .join("|")
}

/**
 * GET /api/tasks/:id/subtasks: a parent's children, archived ones too, with
 * each one's clipped result and report counts. The daemon announces a
 * child's change about the CHILD, so the key carries the family's stamp from
 * the live task list the events bridge already refreshes: a child that moves
 * refetches its parent's list, and nothing polls.
 */
export function useSubtasks(taskId: string | null, enabled: boolean) {
  const { transport, qk } = useDaemonRuntime()
  const stamp = useQuery({
    queryKey: qk.tasksList(false),
    queryFn: skipToken,
    select: (tasks: ApiTask[]) => familyStamp(tasks, taskId),
  }).data
  return useQuery({
    queryKey: [...qk.task(taskId ?? ""), "subtasks", stamp ?? ""],
    queryFn: () => transport.request<ApiSubtask[]>(`/api/tasks/${taskId}/subtasks`),
    enabled: enabled && taskId !== null,
    // a refetch for a new stamp keeps the rows on screen
    placeholderData: keepPreviousData,
  })
}

/** How many unarchived subtasks the live list shows under `taskId`: the phone's tab strip shows Subtasks only then. */
export function useSubtaskCount(taskId: string | null): number {
  const { qk } = useDaemonRuntime()
  return useQuery({
    queryKey: qk.tasksList(false),
    queryFn: skipToken,
    select: (tasks: ApiTask[]) => (taskId ? tasks.filter((task) => task.parent_task_id === taskId && !task.archived).length : 0),
  }).data ?? 0
}
