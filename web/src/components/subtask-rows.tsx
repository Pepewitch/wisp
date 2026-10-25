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
function SubtaskCount({ node, open }: { node: TaskNode; open: boolean }) {
  const { running, needsInput } = open ? { running: false, needsInput: false } : rollup(node)
  const says = needsInput ? "a subtask needs input" : running ? "a subtask is running" : null
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-faint" data-subtask-count={node.children.length}>
      {says && (
        <span
          role="img"
          aria-label={says}
          title={says}
          data-rollup={needsInput ? "needs-input" : "running"}
          className={cn("size-1.5 rounded-full", needsInput ? "bg-state-needs-input" : "bg-state-running")}
        />
      )}
      <span aria-hidden>{node.children.length}</span>
    </span>
  )
}

/** A subtask drawn as a root names its parent; an orphan says its parent is gone. */
function ParentNote({ task, depth, titleOf }: { task: ApiTask; depth: number; titleOf: (id: string) => string | null }) {
  const parent = parentOutside(task, depth)
  if (parent) {
    const title = titleOf(parent) ?? parent
    return (
      <span className="max-w-[45%] shrink truncate text-[10.5px] text-faint" title={`Subtask of ${title}`} data-parent-note>
        ↳ {title}
      </span>
    )
  }
  return isOrphan(task) ? <span className="shrink-0 text-[10.5px] text-faint" data-parent-note>parent deleted</span> : null
}

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
  // a list with any family leaves every row the disclosure's column, so the dots line up
  const gutter = !touch && nodes.some((node) => node.children.length > 0)
  return visibleRows(nodes, disclosure.isOpen).map(({ node, depth }) => {
    const { task } = node
    const open = disclosure.isOpen(task.id)
    const family = node.children.length > 0
    const props = {
      task,
      status: status?.[task.id],
      pullRequest: pullRequests?.[task.id],
      selected: task.id === selectedId,
      onSelect,
      depth,
      lead: family ? <DisclosureButton task={task} count={node.children.length} open={open} onToggle={() => disclosure.toggle(task.id)} touch={touch} /> : undefined,
      trail: (
        <>
          {family && <SubtaskCount node={node} open={open} />}
          <ParentNote task={task} depth={depth} titleOf={titleOf} />
        </>
      ),
      parentTitle: task.parent_task_id ? titleOf(task.parent_task_id) : null,
    }
    return touch ? <TaskRowTouch key={task.id} {...props} /> : <TaskRow key={task.id} {...props} gutter={gutter} />
  })
}
