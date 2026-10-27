import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { ProjectOrderQueue, type ProjectMove } from "@/lib/project-order-queue"
import { useDaemonRuntime } from "@/lib/runtime"

/** What the sidebar needs to reorder projects, or undefined when the daemon cannot save an order. */
export interface ProjectOrder {
  onReorder: (path: string, move: ProjectMove) => void
  /** the last refused reorder, shown inline until dismissed or the next move */
  error: string | null
  onDismissError: () => void
}

/**
 * PUT /api/repos/order, through one ProjectOrderQueue per connection: the
 * sidebar moves at once, saves go out one at a time with the latest order
 * winning, and a refusal puts back the order the daemon last accepted.
 * `enabled` is the daemon advertising `features.projectOrder`.
 */
export function useProjectOrder(enabled: boolean): ProjectOrder | undefined {
  const client = useQueryClient()
  const { connectionId, transport, qk } = useDaemonRuntime()
  const queues = useRef(new Map<string, ProjectOrderQueue>())
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  if (!enabled) return undefined

  const setError = (id: string, message: string | null) =>
    setErrors((current) => {
      if (message === null) {
        if (!(id in current)) return current
        return Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
      }
      return { ...current, [id]: message }
    })
  const queue = () => {
    let found = queues.current.get(connectionId)
    if (!found) {
      const id = connectionId
      found = new ProjectOrderQueue({ client, transport, qk }, (message) => setError(id, message))
      queues.current.set(id, found)
    }
    return found
  }
  const error = errors[connectionId]
  return {
    onReorder: (path, move) => queue().move(path, move),
    error: error === undefined ? null : `Could not save the project order: ${error}`,
    onDismissError: () => setError(connectionId, null),
  }
}
