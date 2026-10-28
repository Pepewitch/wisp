import { useLayoutEffect, useMemo, useRef } from "react"

import { ProjectSection, type ProjectOrderControls } from "@/components/sidebar-sections"
import { useProjectDrag } from "@/hooks/useProjectDrag"
import type { SubtaskTreeView } from "@/hooks/useSidebarTree"
import type { ProjectMove } from "@/lib/project-order-queue"
import type { ProjectGroup } from "@/lib/projects"
import type { SidebarList } from "@/lib/subtask-tree"
import { closeTitleTip } from "@/lib/title-tips"
import type { PullRequestOverviewEntry, StatusEntry } from "@/lib/types"

/**
 * The project sections, and reordering them when the daemon can save an
 * order (`features.projectOrder`): drag a configured project's header (on
 * touch, after a long press), or Alt+↑ / Alt+↓ on its focused header.
 * Only configured projects move; a repo known only from its tasks stays
 * after them and never drags. Without `onReorder` the list is as it was.
 */
export function ProjectList({
  groups,
  lists,
  onReorder,
  ...section
}: {
  groups: ProjectGroup[]
  lists: readonly SidebarList[]
  onReorder?: (path: string, move: ProjectMove) => void
  view: SubtaskTreeView
  status: Record<string, StatusEntry>
  pullRequests: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  onNewTask: (repoPath: string) => void
  onConfigureProject: (repoPath: string, section?: "verification") => void
  verification: boolean
  touch: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const paths = useMemo(() => groups.filter((group) => group.configured).map((group) => group.path), [groups])
  const drag = useProjectDrag({ listRef, paths, onReorder })
  // A keyboard move re-sorts the sections, and a section the DOM moves loses
  // focus: put it back on the moved project's header.
  const refocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const path = refocus.current
    if (path === null) return
    refocus.current = null
    const toggle = listRef.current?.querySelector<HTMLElement>(`[data-project-path="${CSS.escape(path)}"] [aria-expanded]`)
    if (toggle && document.activeElement !== toggle) toggle.focus()
  }, [paths])

  const orderOf = (group: ProjectGroup): ProjectOrderControls | undefined => {
    const index = paths.indexOf(group.path)
    if (!onReorder || index < 0 || paths.length < 2) return undefined
    return {
      canMoveUp: index > 0,
      canMoveDown: index < paths.length - 1,
      onMove: (step) => {
        refocus.current = group.path
        closeTitleTip()
        onReorder(group.path, { step })
      },
      dragging: drag.dragging === group.path,
      onPointerDown: (event) => drag.onPointerDown(group.path, event),
    }
  }

  return (
    <div ref={listRef} className="relative flex flex-col">
      {groups.map((group) => (
        <ProjectSection
          key={group.path}
          group={group}
          list={lists.find((list) => list.key === `project:${group.path}`) ?? { key: group.path, nodes: [] }}
          order={orderOf(group)}
          {...section}
        />
      ))}
      {drag.lineTop !== null && (
        <div
          aria-hidden
          data-drop-line
          className="pointer-events-none absolute inset-x-1 h-0.5 -translate-y-1/2 rounded-full bg-primary"
          style={{ top: drag.lineTop }}
        />
      )}
    </div>
  )
}
