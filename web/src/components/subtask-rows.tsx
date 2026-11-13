import { memo } from "react"

import { ChevronRight } from "@/components/icons"
import { TaskRow, TaskRowTouch } from "@/components/task-row"
import type { SubtaskTreeView } from "@/hooks/useSidebarTree"
import { isOrphan, parentOutside, rollup, visibleRows, type TaskNode } from "@/lib/subtask-tree"
import type { ApiTask, PullRequestOverviewEntry, StatusEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * One sidebar list drawn as a tree: subtasks under their parent, collapsed
 * until opened, with a count and a rollup dot on the parent while they are
 * hidden. Which rows are on screen comes from lib/subtask-tree, the same
 * answer Ctrl+Tab walks.
 */

const plural = (n: number) => `${n} subtask${n === 1 ? "" : "s"}`

/**
 * Its own button beside the row, never inside it: a button in a button is
 * invalid, and opening a parent must not select it. On touch it is a whole
 * 44px target at the row's right edge.
 */
function DisclosureButton({ task, count, open, onToggle, touch }: {
  task: ApiTask
  count: number
  open: boolean
  onToggle: () => void
  touch: boolean
}) {
  const label = `${open ? "Hide" : "Show"} ${plural(count)} of ${task.title}`
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      title={label}
      data-subtask-disclosure={task.id}
      onClick={onToggle}
      className={cn(
        "absolute top-1/2 z-10 flex -translate-y-1/2 items-center justify-center text-muted-foreground",
        "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        touch ? "right-0 size-11 rounded-lg" : "left-[5px] size-[18px] rounded-sm hover:bg-hover",
      )}
    >
      <ChevronRight aria-hidden className={cn("transition-transform", touch ? "size-4" : "size-3", open && "rotate-90")} />
    </button>
  )
}

/** The count, and while the children are hidden, whether one runs or needs the person. */
function SubtaskCount({ count, running, needsInput }: { count: number; running: boolean; needsInput: boolean }) {
  const says = needsInput ? "a subtask needs input" : running ? "a subtask is running" : null
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-faint" data-subtask-count={count}>
      {says && (
        <span
          role="img"
          aria-label={says}
          title={says}
          data-rollup={needsInput ? "needs-input" : "running"}
          className={cn("size-1.5 rounded-full", needsInput ? "bg-state-needs-input" : "bg-state-running")}
        />
      )}
      <span aria-hidden>{count}</span>
    </span>
  )
}

/** A subtask drawn as a root names its parent (`title`); an orphan says its parent is gone. */
function ParentNote({ task, title }: { task: ApiTask; title: string | null }) {
  if (title) {
    return (
      <span className="max-w-[45%] shrink truncate text-[10.5px] text-faint" title={`Subtask of ${title}`} data-parent-note>
        ↳ {title}
      </span>
    )
  }
  return isOrphan(task) ? <span className="shrink-0 text-[10.5px] text-faint" data-parent-note>parent deleted</span> : null
}

const QUIET = { running: false, needsInput: false }

/**
 * One row of the tree. Its props are data, never elements or tree nodes: the
 * sidebar redraws whenever the main view does and rebuilds its nodes on every
 * list refetch, while Query hands back the same task for a row that did not
 * change. A row whose task, status and selection held is skipped.
 */
const TreeRow = memo(function TreeRow({ task, depth, count, open, running, needsInput, onToggle, status, pullRequest, selected, onSelect, parentTitle, parentNote, touch }: {
  task: ApiTask
  depth: number
  /** how many subtasks it has; 0 draws no disclosure */
  count: number
  open: boolean
  /** while its subtasks are hidden: whether one of them runs, or needs the person */
  running: boolean
  needsInput: boolean
  onToggle: (id: string) => void
  status?: StatusEntry
  pullRequest?: PullRequestOverviewEntry
  selected: boolean
  onSelect: (id: string) => void
  parentTitle: string | null
  /** the parent this row names because it is drawn outside it */
  parentNote: string | null
  touch: boolean
}) {
  const family = count > 0
  const props = {
    task,
    status,
    pullRequest,
    selected,
    onSelect,
    depth,
    lead: family ? <DisclosureButton task={task} count={count} open={open} onToggle={() => onToggle(task.id)} touch={touch} /> : undefined,
    trail: (
      <>
        {family && <SubtaskCount count={count} running={running} needsInput={needsInput} />}
        <ParentNote task={task} title={parentNote} />
      </>
    ),
    parentTitle,
  }
  return touch ? <TaskRowTouch {...props} /> : <TaskRow {...props} />
})

/** The rows of one list, nested. */
export function TaskTree({ nodes, view, status, pullRequests, selectedId, onSelect, touch }: {
  nodes: readonly TaskNode[]
  view: SubtaskTreeView
  /** live rows only; archived ones pass nothing */
  status?: Record<string, StatusEntry>
  pullRequests?: Record<string, PullRequestOverviewEntry>
  selectedId: string | null
  onSelect: (id: string) => void
  touch: boolean
}) {
  const { disclosure, titleOf } = view
  return visibleRows(nodes, disclosure.isOpen).map(({ node, depth }) => {
    const { task } = node
    const parent = parentOutside(task, depth)
    const open = disclosure.isOpen(task.id)
    const { running, needsInput } = open || node.children.length === 0 ? QUIET : rollup(node)
    return (
      <TreeRow
        key={task.id}
        task={task}
        depth={depth}
        count={node.children.length}
        open={open}
        running={running}
        needsInput={needsInput}
        onToggle={disclosure.toggle}
        status={status?.[task.id]}
        pullRequest={pullRequests?.[task.id]}
        selected={task.id === selectedId}
        onSelect={onSelect}
        parentTitle={task.parent_task_id ? titleOf(task.parent_task_id) : null}
        parentNote={parent ? (titleOf(parent) ?? parent) : null}
        touch={touch}
      />
    )
  })
}
