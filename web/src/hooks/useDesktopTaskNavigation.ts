import { useEffect } from "react"

export type TaskNavigationDirection = "next" | "previous"

/** The adjacent sidebar task, wrapping at either end of the list. */
export function adjacentTaskId(
  taskIds: readonly string[],
  selectedId: string | null,
  direction: TaskNavigationDirection
): string | null {
  if (taskIds.length === 0) return null
  const selectedIndex = selectedId === null ? -1 : taskIds.indexOf(selectedId)
  if (selectedIndex === -1) {
    return direction === "next" ? taskIds[0]! : taskIds[taskIds.length - 1]!
  }
  const offset = direction === "next" ? 1 : -1
  return taskIds[(selectedIndex + offset + taskIds.length) % taskIds.length]!
}

/**
 * Desktop owns Ctrl+Tab; the browser keeps its native tab-switching shortcut.
 * `taskIds` are the sidebar's rows on screen, in order (useSidebarTree), so a
 * collapsed parent's subtasks are stepped over.
 */
export function useDesktopTaskNavigation(
  enabled: boolean,
  taskIds: readonly string[],
  selectedId: string | null,
  onSelect: (taskId: string) => void
): void {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return
      }
      const nextId = adjacentTaskId(
        taskIds,
        selectedId,
        event.shiftKey ? "previous" : "next"
      )
      if (nextId === null) return
      event.preventDefault()
      onSelect(nextId)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onSelect, selectedId, taskIds])
}
