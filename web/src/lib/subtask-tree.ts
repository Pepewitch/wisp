import type { ApiTask } from "./types"

/*
 * The sidebar's subtask nesting, as pure data: which task sits under which,
 * in what order, what a collapsed parent says about its children, and which
 * rows are on screen. The sidebar draws it and Ctrl+Tab walks it, so the two
 * can never disagree about what is visible.
 */

/** A task with the subtasks drawn under it. */
export interface TaskNode {
  readonly task: ApiTask
  readonly children: readonly TaskNode[]
}

/** A row on screen: the node, and how far it is indented. */
export interface TaskRowPlace {
  readonly node: TaskNode
  readonly depth: number
}

/** One of auto-review's reviewers: Wisp answers its questions itself. */
export const isReviewer = (task: Pick<ApiTask, "verify_role">): boolean => task.verify_role === "reviewer"

/** A subtask whose parent was deleted: it keeps its kind and loses its parent. */
export const isOrphan = (task: Pick<ApiTask, "subtask_kind" | "parent_task_id">): boolean =>
  Boolean(task.subtask_kind) && !task.parent_task_id

/** The newest activity anywhere in a family: a parent with a busy child does not sink. */
function familyActivity(node: TaskNode): string {
  return node.children.reduce((latest, child) => {
    const at = familyActivity(child)
    return at > latest ? at : latest
  }, node.task.updated_at)
}

/**
 * The tasks of one list (a project's, or one archive section's) as trees.
 * A task nests under its parent only when the parent is in the same list;
 * otherwise it is a root of its own, and the row says where its parent is
 * (`parentOutside`). Roots sort by their family's latest activity, newest
 * first; children by when they were made, so a busy child does not reshuffle
 * its siblings.
 */
export function nestTasks(tasks: readonly ApiTask[]): TaskNode[] {
  const ids = new Set(tasks.map((task) => task.id))
  const nested = (task: ApiTask) => Boolean(task.parent_task_id && task.parent_task_id !== task.id && ids.has(task.parent_task_id))
  const childrenOf = new Map<string, ApiTask[]>()
  for (const task of tasks) {
    if (!nested(task)) continue
    const siblings = childrenOf.get(task.parent_task_id!) ?? []
    siblings.push(task)
    childrenOf.set(task.parent_task_id!, siblings)
  }
  // `seen` guards a cycle no daemon writes: each task is drawn once
  const seen = new Set<string>()
  const build = (task: ApiTask): TaskNode => {
    seen.add(task.id)
    const children = (childrenOf.get(task.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(build)
    return { task, children }
  }
  const roots = tasks.filter((task) => !nested(task)).map(build)
  // a cycle has no root: draw what is left flat rather than lose it
  for (const task of tasks) if (!seen.has(task.id)) roots.push(build(task))
  return roots
    .map((node) => ({ node, at: familyActivity(node) }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ node }) => node)
}

/** Every task as a root of its own: an older daemon, or the feature off. */
export const flatTasks = (tasks: readonly ApiTask[]): TaskNode[] => tasks.map((task) => ({ task, children: [] }))

/**
 * What a parent says about its subtasks while they are hidden: one is running
 * (a reviewer too, since the parent's PR waits on it), or one needs the
 * person. A reviewer needing input is left out: Wisp answers it. Display
 * only: nothing decides anything from it.
 */
export function rollup(node: TaskNode): { running: boolean; needsInput: boolean } {
  let running = false
  let needsInput = false
  const walk = (children: readonly TaskNode[]) => {
    for (const child of children) {
      if (child.task.state === "running") running = true
      if (child.task.state === "needs-input" && !isReviewer(child.task)) needsInput = true
      walk(child.children)
    }
  }
  walk(node.children)
  return { running, needsInput }
}

/** The rows on screen, depth first, skipping the children of a collapsed parent. */
export function visibleRows(nodes: readonly TaskNode[], isOpen: (id: string) => boolean, depth = 0): TaskRowPlace[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.children.length > 0 && isOpen(node.task.id) ? visibleRows(node.children, isOpen, depth + 1) : []),
  ])
}

/** A subtask's parent that the row has to name, because it is not drawn above it. */
export function parentOutside(task: Pick<ApiTask, "parent_task_id">, depth: number): string | null {
  return depth === 0 && task.parent_task_id ? task.parent_task_id : null
}

/** The ids above `id`, nearest first, from each task's own parent link. */
export function ancestorIds(tasks: readonly Pick<ApiTask, "id" | "parent_task_id">[], id: string | null): string[] {
  const parentOf = new Map(tasks.map((task) => [task.id, task.parent_task_id ?? null]))
  const ancestors: string[] = []
  for (let at = id ? parentOf.get(id) : null; at && !ancestors.includes(at); at = parentOf.get(at)) ancestors.push(at)
  return ancestors
}

/** The archive's two sections: unfinished cleanup first, so it stays in view, then history. */
export function archivePartitions<T extends Pick<ApiTask, "cleanup">>(archived: readonly T[]): { label: "Cleanup" | "Archived"; tasks: T[] }[] {
  const incomplete = (task: T) => Boolean(task.cleanup && task.cleanup.state !== "complete")
  return [
    { label: "Cleanup", tasks: archived.filter(incomplete) },
    { label: "Archived", tasks: archived.filter((task) => !incomplete(task)) },
  ]
}

/** One list the sidebar draws: a project's tasks, or one archive section. */
export interface SidebarList {
  readonly key: string
  readonly nodes: readonly TaskNode[]
}

/**
 * Every list in sidebar order: each project, then Cleanup, then Archived,
 * each nested on its own when `nest` (the daemon has subtasks), flat otherwise.
 */
export function sidebarLists(
  groups: readonly { path: string; tasks: readonly ApiTask[] }[],
  archived: readonly ApiTask[],
  nest: boolean,
): SidebarList[] {
  const shape = nest ? nestTasks : flatTasks
  return [
    ...groups.map((group) => ({ key: `project:${group.path}`, nodes: shape(group.tasks) })),
    ...archivePartitions(archived).map((part) => ({ key: `archive:${part.label}`, nodes: shape(part.tasks) })),
  ]
}

/** The ids on screen in order: what Ctrl+Tab steps through. */
export function visibleTaskIds(lists: readonly SidebarList[], isOpen: (id: string) => boolean): string[] {
  return lists.flatMap((list) => visibleRows(list.nodes, isOpen).map((row) => row.node.task.id))
}
