import { useCallback, useMemo } from "react"

import { useSubtaskDisclosure, type SubtaskDisclosure } from "@/hooks/useSubtaskDisclosure"
import { sidebarLists, visibleTaskIds, type SidebarList } from "@/lib/subtask-tree"
import { groupTasksByProject, type ProjectGroup } from "@/lib/projects"
import type { ApiTask, RepoInfo } from "@/lib/types"

/** What the rows need to know about the whole sidebar's nesting. */
export interface SubtaskTreeView {
  disclosure: SubtaskDisclosure
  /** a task's title from the full list, for a parent that is not drawn above its child */
  titleOf: (id: string) => string | null
}

/** The sidebar's lists, nested or flat, and the rows on screen in order. */
export interface SidebarTree {
  /** live tasks by project, in the daemon's order */
  groups: ProjectGroup[]
  archivedTasks: ApiTask[]
  lists: SidebarList[]
  view: SubtaskTreeView
  /** what Ctrl+Tab steps through: collapsed children are not on screen */
  visibleIds: string[]
}

/** A sidebar with no nesting: an older daemon, a test, a gallery specimen. */
export const FLAT_VIEW: SubtaskTreeView = { disclosure: { isOpen: () => false, toggle: () => {} }, titleOf: () => null }

/**
 * One answer to "which tasks sit under which, and which are on screen", for
 * the sidebar and the keyboard alike. `nest` is the daemon advertising
 * `features.subtasks`; without it every task is a root, as before subtasks.
 */
export function useSidebarTree({ connectionId, tasks, repos, nest, selectedId }: {
  connectionId: string
  tasks: ApiTask[]
  repos: RepoInfo[] | undefined
  nest: boolean
  selectedId: string | null
}): SidebarTree {
  const groups = useMemo(() => groupTasksByProject(tasks.filter((t) => !t.archived), repos ?? []), [tasks, repos])
  const archivedTasks = useMemo(() => tasks.filter((t) => t.archived), [tasks])
  const all = tasks
  const disclosure = useSubtaskDisclosure(connectionId, nest ? all : [], selectedId)
  const titles = useMemo(() => new Map(all.map((task) => [task.id, task.title])), [all])
  const titleOf = useCallback((id: string) => titles.get(id) ?? null, [titles])
  const lists = useMemo(() => sidebarLists(groups, archivedTasks, nest), [groups, archivedTasks, nest])
  const visibleIds = useMemo(() => visibleTaskIds(lists, disclosure.isOpen), [lists, disclosure.isOpen])
  const view = useMemo(() => ({ disclosure, titleOf }), [disclosure, titleOf])
  return { groups, archivedTasks, lists, view, visibleIds }
}
