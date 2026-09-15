import { useEffect, useMemo } from "react"

export type TaskNavigationDirection = "next" | "previous"

type NavigableTask = {
  readonly id: string
  readonly cleanup?: { readonly state: string } | null
}

type NavigableGroup = {
  readonly tasks: readonly NavigableTask[]
}

/** Match the sidebar: project rows, unfinished cleanup, then archive history. */
export function sidebarTaskIds(
  groups: readonly NavigableGroup[],
  archivedTasks: readonly NavigableTask[]
): string[] {
  const archivedByCleanup = (incomplete: boolean) =>
    archivedTasks.filter(
      (task) =>
        Boolean(task.cleanup && task.cleanup.state !== "complete") === incomplete
    )
  return [
    ...groups.flatMap((group) => group.tasks.map((task) => task.id)),
    ...archivedByCleanup(true).map((task) => task.id),
    ...archivedByCleanup(false).map((task) => task.id),
  ]
}

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

/** Desktop owns Ctrl+Tab; the browser keeps its native tab-switching shortcut. */
export function useDesktopTaskNavigation(
  enabled: boolean,
  groups: readonly NavigableGroup[],
  archivedTasks: readonly NavigableTask[],
  selectedId: string | null,
  onSelect: (taskId: string) => void
): void {
  const taskIds = useMemo(
    () => sidebarTaskIds(groups, archivedTasks),
    [archivedTasks, groups]
  )
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
