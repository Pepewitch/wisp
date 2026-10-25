import { useLiveTasks } from "@/hooks/queries"

/**
 * Another task's title, read from the live task list the sidebar already
 * keeps: never a request of its own. Null while that list has no such task
 * (it was deleted, or it is archived).
 */
export function useTaskTitle(id: string | null): string | null {
  return useLiveTasks((tasks) => (id ? tasks.find((task) => task.id === id)?.title ?? null : null)).data ?? null
}
