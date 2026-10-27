import { useReorderProjects } from "@/hooks/mutations"

/** What the sidebar needs to reorder projects, or undefined when the daemon cannot save an order. */
export interface ProjectOrder {
  onReorder: (paths: string[]) => void
  /** the last refused reorder, shown inline until dismissed or the next one */
  error: string | null
  onDismissError: () => void
}

/** `enabled` is the daemon advertising `features.projectOrder`. */
export function useProjectOrder(enabled: boolean): ProjectOrder | undefined {
  const reorder = useReorderProjects()
  if (!enabled) return undefined
  return {
    onReorder: (paths) => reorder.mutate(paths),
    error: reorder.error ? `Could not save the project order: ${reorder.error.message}` : null,
    onDismissError: reorder.reset,
  }
}
