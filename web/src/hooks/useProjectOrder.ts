import { useQueryClient } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"

import { projectOrderQueue, type ProjectMove } from "@/lib/project-order-queue"
import { useDaemonRuntime } from "@/lib/runtime"

/** What the sidebar needs to reorder projects, or undefined when the daemon cannot save an order. */
export interface ProjectOrder {
  onReorder: (path: string, move: ProjectMove) => void
  /** the configured order to show over the daemon's while a save is out (`shownRepos`) */
  pending: readonly string[] | null
  /** the last refused reorder, shown inline until dismissed or the next move */
  error: string | null
  onDismissError: () => void
}

/**
 * PUT /api/repos/order through the connection's ProjectOrderQueue: the
 * sidebar shows a move at once, saves go out one at a time with the latest
 * order winning, and a refusal says why. `enabled` is the daemon advertising
 * `features.projectOrder`.
 */
export function useProjectOrder(enabled: boolean): ProjectOrder | undefined {
  const client = useQueryClient()
  const { connectionId, transport, qk } = useDaemonRuntime()
  const queue = projectOrderQueue(client, connectionId, qk, transport)
  const state = useSyncExternalStore(queue.subscribe, queue.getState)
  if (!enabled) return undefined
  return {
    onReorder: (path, move) => queue.move(path, move, transport),
    pending: state.pending,
    error: state.error === null ? null : `Could not save the project order: ${state.error}`,
    onDismissError: () => queue.dismissError(),
  }
}
