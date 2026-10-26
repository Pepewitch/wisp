import { useTaskTitle } from "@/hooks/useTaskTitle"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/**
 * The phone task sheet's line for a subtask: "↳ <kind> subtask of <parent>".
 * The parent's name opens the parent; an orphan says its parent was deleted.
 * The pointer shell's form is `ParentCrumb`, in the top bar.
 */
export function SubtaskCrumb({ task }: { task: ApiTask }) {
  if (!task.subtask_kind) return null
  return (
    <span data-subtask-crumb className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <span aria-hidden className="shrink-0 text-faint">↳</span>
      <span className="shrink-0">{task.subtask_kind} subtask of</span>
      <ParentLink task={task} touch className="text-fg-secondary" />
    </span>
  )
}

/**
 * `Parent ›` before a subtask's title in the top bar. The parent is capped at
 * 14rem and gives way first when the bar is narrow (it shrinks three times as
 * fast as the title and keeps a few letters), so the task you are IN stays
 * readable.
 * Its kind and base are in the title menu.
 */
export function ParentCrumb({ task, dragRegion = false }: { task: ApiTask; dragRegion?: boolean }) {
  if (!task.subtask_kind) return null
  // the gap and the `›` drag the Desktop window like the rest of the bar's quiet parts (§5h)
  const drag = dragRegion ? "" : undefined
  return (
    <span data-subtask-crumb data-tauri-drag-region={drag} className="flex max-w-56 min-w-12 shrink-[3] items-center gap-1.5 text-[13px] text-muted-foreground">
      <ParentLink task={task} className="text-muted-foreground" />
      <span aria-hidden data-tauri-drag-region={drag} className="shrink-0 text-faint">›</span>
    </span>
  )
}

/** `touch` gives the name a 44px hit target, the floor for a thumb (frontend §6b). */
function ParentLink({ task, touch = false, className }: { task: ApiTask; touch?: boolean; className?: string }) {
  const { connectionId } = useDaemonRuntime()
  const parent = task.parent_task_id
  const parentTitle = useTaskTitle(parent ?? null)
  // words, not a control: a press on them falls through to the crumb (and its drag region)
  if (!parent) return <span className="pointer-events-none shrink-0">a deleted task</span>
  return (
    <button
      type="button"
      onClick={() => uiIntentsFor(connectionId).focusTask(parent)}
      title={`Open ${parentTitle ?? parent}`}
      className={cn(
        "min-w-0 underline-offset-2 hover:text-foreground hover:underline",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        touch ? "flex min-h-11 items-center" : "truncate",
        className,
      )}
    >
      {touch ? <span className="truncate">{parentTitle ?? parent}</span> : parentTitle ?? parent}
    </button>
  )
}
