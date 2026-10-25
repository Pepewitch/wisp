import { useTaskTitle } from "@/hooks/useTaskTitle"
import { useDaemonRuntime } from "@/lib/runtime"
import { baseWords } from "@/lib/subtask-words"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/**
 * "↳ subtask of <parent>" over a subtask's title, with its kind and base. The
 * parent's name opens the parent. An orphan says its parent was deleted.
 * `compact` is the phone header's one meta item: the kind and the parent,
 * with the base left to the desktop line.
 */
export function SubtaskCrumb({ task, compact = false }: { task: ApiTask; compact?: boolean }) {
  const { connectionId } = useDaemonRuntime()
  const parentTitle = useTaskTitle(task.parent_task_id ?? null)
  if (!task.subtask_kind) return null
  const parent = task.parent_task_id
  const base = compact ? null : baseWords(task)
  return (
    <span data-subtask-crumb className={cn("flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground", !compact && "mb-1")}>
      <span aria-hidden className="shrink-0 text-faint">↳</span>
      <span className="shrink-0">{task.subtask_kind} subtask of</span>
      {parent ? (
        <button
          type="button"
          onClick={() => uiIntentsFor(connectionId).focusTask(parent)}
          title={`Open ${parentTitle ?? parent}`}
          className={cn(
            "min-w-0 truncate text-fg-secondary underline-offset-2 hover:text-foreground hover:underline",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            // a finger needs more than a line of text: the hit area grows, the line does not
            compact && "-my-2 py-2",
          )}
        >
          {parentTitle ?? parent}
        </button>
      ) : (
        <span className="shrink-0">a deleted task</span>
      )}
      {base && (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <span className="min-w-0 truncate" title="where its worktree started">from {base}</span>
        </>
      )}
    </span>
  )
}
