import { useCallback, useEffect, useMemo, useState } from "react"

import { readConnectionStorage, writeConnectionStorage } from "@/lib/connection-storage"
import { ancestorIds } from "@/lib/subtask-tree"
import type { ApiTask } from "@/lib/types"

const STORAGE_NAME = "subtasks_open"
// never written before connection-scoped storage: nothing to adopt
const NO_LEGACY_KEY = "wisp_subtasks_open"
/** Enough parents for anyone's sidebar; the oldest opened go first. */
const KEEP = 200

function readOpen(connectionId: string): string[] {
  try {
    const value: unknown = JSON.parse(readConnectionStorage(connectionId, STORAGE_NAME, NO_LEGACY_KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

export interface SubtaskDisclosure {
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
}

/**
 * Which parents show their subtasks: collapsed by default, remembered per
 * parent in this browser, per connection. Selecting a hidden child (search,
 * a deep link, a notification, Ctrl+Tab) opens every parent above it, once:
 * collapsing one again while the child stays selected sticks.
 */
export function useSubtaskDisclosure(
  connectionId: string,
  tasks: readonly Pick<ApiTask, "id" | "parent_task_id">[],
  selectedId: string | null,
): SubtaskDisclosure {
  const [state, setState] = useState(() => ({ connectionId, open: readOpen(connectionId) }))
  // another connection's sidebar is another set of parents
  let current = state
  if (state.connectionId !== connectionId) {
    current = { connectionId, open: readOpen(connectionId) }
    setState(current)
  }

  const ancestors = useMemo(() => ancestorIds(tasks, selectedId), [tasks, selectedId])
  const reveal = `${connectionId}|${selectedId}|${ancestors.join(",")}`
  const [revealed, setRevealed] = useState<string | null>(null)
  if (revealed !== reveal) {
    setRevealed(reveal)
    const hidden = ancestors.filter((id) => !current.open.includes(id))
    if (hidden.length > 0) setState({ connectionId, open: [...current.open, ...hidden].slice(-KEEP) })
  }

  useEffect(() => {
    writeConnectionStorage(state.connectionId, STORAGE_NAME, NO_LEGACY_KEY, JSON.stringify(state.open))
  }, [state])

  const open = useMemo(() => new Set(current.open), [current.open])
  const isOpen = useCallback((id: string) => open.has(id), [open])
  const toggle = useCallback(
    (id: string) =>
      setState((prev) => ({
        connectionId: prev.connectionId,
        open: prev.open.includes(id) ? prev.open.filter((at) => at !== id) : [...prev.open, id].slice(-KEEP),
      })),
    [],
  )
  return { isOpen, toggle }
}
