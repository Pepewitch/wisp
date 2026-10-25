import { useState, type ReactNode } from "react"

import { Plus } from "@/components/icons"
import { NewSubtaskDialog } from "@/components/new-subtask-dialog"
import { Button, PaneHeader, StateDot } from "@/components/primitives"
import { useSubtasks } from "@/hooks/useSubtasks"
import { failureReason } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import { STATE_LABEL, STATE_TEXT } from "@/lib/state"
import type { ApiSubtask, ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/** Where its reports to this task stand; nothing when there is nothing to say. */
function reportWords(subtask: ApiSubtask): string | null {
  if (!subtask.report_to_parent) return "does not report back"
  const waiting = subtask.reports.pending + subtask.reports.queued
  const words = [
    waiting > 0 && `${waiting} report${waiting === 1 ? "" : "s"} waiting to reach this task`,
    subtask.reports.dropped > 0 && `${subtask.reports.dropped} dropped`,
  ].filter(Boolean)
  return words.length > 0 ? words.join(" · ") : null
}

function SubtaskItem({ subtask, onOpen, touch }: { subtask: ApiSubtask; onOpen: () => void; touch: boolean }) {
  const reports = reportWords(subtask)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-subtask={subtask.id}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2.5 text-left hover:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          touch ? "min-h-11 py-2" : "py-1.5",
          subtask.archived && "opacity-60",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StateDot state={subtask.state} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{subtask.title}</span>
          <span className="shrink-0 text-[10.5px] text-faint">
            {subtask.reviewer ? "reviewer" : subtask.kind ?? "subtask"}
            {subtask.archived && " · archived"}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px]">
          <span className={cn("shrink-0", STATE_TEXT[subtask.state])}>{STATE_LABEL[subtask.state]}</span>
          {reports && (
            <>
              <span aria-hidden className="text-faint">·</span>
              <span className="truncate text-muted-foreground">{reports}</span>
            </>
          )}
        </span>
        {subtask.result && (
          <span className="line-clamp-2 pl-3.5 text-[11px] leading-snug whitespace-pre-line text-fg-secondary wrap-anywhere">
            {subtask.result}
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * The parent's subtasks, from GET /api/tasks/:id/subtasks: each child's
 * state, kind, newest result (clipped; the whole is `wisp result <id>`) and
 * where its reports to this task stand. A row opens the child. New subtask
 * is here, beside what it adds to; a subtask itself cannot have one, and an
 * archived task takes none.
 */
export function SubtasksPane({ task, header, hidden = false, touch = false }: {
  task: ApiTask | null
  /** the right column's tab strip, when this is the visible pane */
  header?: ReactNode
  hidden?: boolean
  touch?: boolean
}) {
  const { connectionId } = useDaemonRuntime()
  const [creating, setCreating] = useState(false)
  const subtasks = useSubtasks(task?.id ?? null, !hidden)
  const why = !task ? null : task.archived ? "An archived task takes no new subtasks" : task.subtask_kind ? "A subtask cannot have subtasks of its own" : null
  const rows = subtasks.data ?? []

  return (
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      {(!touch || header) && (
        <PaneHeader touch={touch} className={header ? "pl-2" : undefined}>
          {header ?? <span className="text-[12.5px] font-medium text-foreground">Subtasks</span>}
        </PaneHeader>
      )}
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {task && (
          <div className="flex items-center gap-2 px-1 pb-2">
            <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
              {why ?? (rows.length > 0 ? `${rows.length} subtask${rows.length === 1 ? "" : "s"}` : "No subtasks yet")}
            </span>
            {!why && (
              <Button size={touch ? "lg" : "sm"} onClick={() => setCreating(true)}>
                <Plus aria-hidden className="size-3.5" />
                New subtask
              </Button>
            )}
          </div>
        )}
        {subtasks.error && <p className="px-2.5 text-[11.5px] text-destructive">{failureReason(subtasks.error)}</p>}
        <ul className="flex flex-col gap-px">
          {rows.map((subtask) => (
            <SubtaskItem key={subtask.id} subtask={subtask} touch={touch} onOpen={() => uiIntentsFor(connectionId).focusTask(subtask.id)} />
          ))}
        </ul>
      </div>
      {task && !why && <NewSubtaskDialog parent={task} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}
