import { skipToken, useQuery } from "@tanstack/react-query"

import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"

/**
 * Another task's title, read from the task list the sidebar already keeps:
 * never a request of its own. Null while that list has no such task (it was
 * deleted, or it is archived and the archive is not loaded).
 */
export function useTaskTitle(id: string | null): string | null {
  const { qk } = useDaemonRuntime()
  const { data } = useQuery({
    queryKey: qk.tasksList(false),
    queryFn: skipToken,
    select: (tasks: ApiTask[]) => (id ? tasks.find((task) => task.id === id)?.title ?? null : null),
  })
  return data ?? null
}
