import { Drawer } from "@base-ui/react/drawer"

import { Archive, ChevronRight, Pencil, Plus, Search, type FluentIcon } from "@/components/icons"
import { SubtaskCrumb } from "@/components/subtask-crumb"
import { SummaryCard } from "@/components/task-summary-card"
import { TOOL_ICON, TOOL_LABEL, useToolHints, type ToolHints } from "@/components/tool-hints"
import { useTaskSummary } from "@/hooks/useTaskSummary"
import { useTaskVerbs, type TaskVerbs } from "@/hooks/useTaskVerbs"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import type { ToolName } from "@/lib/tools"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"

/**
 * The phone's task sheet (frontend §6b): everything about the open task that
 * is not the conversation, one tap from the header's task button. It is the
 * summary card's own rows at touch size (where the task stands, then the
 * session), the task's tools, and its verbs as four tiles. A tool opens full
 * screen behind it; a verb closes the sheet first, so its dialog never opens
 * under the sheet's scrim.
 *
 * A base-ui Drawer swiped down to dismiss, like the task drawer's swipe left.
 * Its body mounts only while it is open, so the card's reads (the `/tokens`
 * report, the autopilot clock) run only while it is on screen. The verbs'
 * dialogs live outside it and outlast it.
 */
export function TaskSheet({ task, pullRequest, turns, open, onOpenChange, tools, onOpenTool, onShowChat }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  turns: Turn[] | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the tools this task offers, in the top bar's order */
  tools: readonly ToolName[]
  onOpenTool: (name: ToolName) => void
  /** bring the conversation on screen, before a find or a jump runs against it */
  onShowChat: () => void
}) {
  const verbs = useTaskVerbs(task)
  const close = () => onOpenChange(false)
  return (
    <>
      <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
          <Drawer.Popup
            className={cn(
              "wisp-sheet fixed inset-x-0 bottom-0 z-(--z-modal) mx-auto flex max-h-[88dvh] w-full max-w-[640px] flex-col",
              "rounded-t-xl border border-b-0 border-border-strong bg-popover shadow-modal outline-none",
            )}
          >
            <div aria-hidden className="mx-auto mt-2 mb-1.5 h-1 w-9 shrink-0 rounded-full bg-border-strong" />
            <Drawer.Title className="sr-only">{task.title}</Drawer.Title>
            <SheetBody
              task={task}
              pullRequest={pullRequest}
              turns={turns}
              tools={tools}
              verbs={verbs}
              onOpenTool={(name) => {
                close()
                onOpenTool(name)
              }}
              onShowChat={onShowChat}
              onDone={close}
            />
          </Drawer.Popup>
        </Drawer.Portal>
      </Drawer.Root>
      {verbs.dialogs}
    </>
  )
}

function SheetBody({ task, pullRequest, turns, tools, verbs, onOpenTool, onShowChat, onDone }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  turns: Turn[] | undefined
  tools: readonly ToolName[]
  verbs: TaskVerbs
  onOpenTool: (name: ToolName) => void
  onShowChat: () => void
  /** after anything in the sheet acted */
  onDone: () => void
}) {
  const summary = useTaskSummary(task, pullRequest, turns)
  const hints = useToolHints(task, pullRequest)
  const model = {
    ...summary,
    // the transcript can only scroll to the question once it is on screen
    onJumpToQuestion: () => {
      onShowChat()
      requestAnimationFrame(summary.onJumpToQuestion)
    },
    onOpenTool,
  }
  const act = (verb: () => void) => () => {
    onDone()
    verb()
  }
  return (
    <div
      className="scroll-slim flex min-h-0 flex-col gap-3 overflow-y-auto px-3 pt-1"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
    >
      <div className="flex min-w-0 flex-col gap-1 px-1">
        {/* the facts the old header's metadata line carried, and the title menu does on the desktop */}
        <span className="truncate font-mono text-[12px] text-muted-foreground">
          {[task.id, task.harness, task.model, task.effort && `${task.effort} effort`].filter(Boolean).join(" · ")}
        </span>
        {task.subtask_kind && <SubtaskCrumb task={task} />}
      </div>
      <SummaryCard model={model} touch onDone={onDone} />
      <ToolRows tools={tools} hints={hints} onOpen={onOpenTool} />
      <VerbTiles
        verbs={verbs}
        onFind={() => {
          onDone()
          // find searches the transcript, so the transcript comes first
          onShowChat()
          requestAnimationFrame(verbs.find)
        }}
        act={act}
      />
    </div>
  )
}

/** One 44px row per tool: its icon, its name, the small form of its state, and the way in. */
function ToolRows({ tools, hints, onOpen }: { tools: readonly ToolName[]; hints: ToolHints; onOpen: (name: ToolName) => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-1">
      {tools.map((name) => {
        const Icon = TOOL_ICON[name]
        const hint = toolHint(name, hints)
        return (
          <button
            key={name}
            type="button"
            onClick={() => onOpen(name)}
            className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[14px] hover:bg-hover active:bg-hover", FOCUS)}
          >
            <Icon
              aria-hidden
              className={cn(
                "size-[18px] shrink-0 text-fg-secondary",
                name === "autopilot" && hints.pullRequest && PULL_REQUEST_ICON_TONE[pullRequestIconTone(hints.pullRequest)],
              )}
            />
            <span className="shrink-0 text-foreground">{TOOL_LABEL[name]}</span>
            {hint && <span className="ml-auto min-w-0 truncate text-muted-foreground tabular-nums">{hint}</span>}
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-faint", !hint && "ml-auto")} />
          </button>
        )
      })}
    </div>
  )
}

function toolHint(name: ToolName, { count, running }: ToolHints): string | null {
  const n = count[name] ?? 0
  if (name === "terminal") return running.length > 0 ? `running ${running.join(", ")}` : null
  if (name === "changes") return n > 0 ? `${n} file${n === 1 ? "" : "s"}` : null
  if (name === "workflows") return n > 0 ? `${n} watching` : null
  if (name === "subtasks") return n > 0 ? String(n) : null
  // Autopilot's state is the card's Autopilot row, just above
  return null
}

/** Find, Rename, New subtask and Archive as tiles: the title menu's verbs, where a thumb reaches them. */
function VerbTiles({ verbs, onFind, act }: {
  verbs: TaskVerbs
  onFind: () => void
  act: (verb: () => void) => () => void
}) {
  const tiles: { label: string; name?: string; icon: FluentIcon; onClick: (() => void) | null }[] = [
    { label: "Find", name: "Find in task", icon: Search, onClick: onFind },
    { label: "Rename", icon: Pencil, onClick: act(verbs.rename) },
    ...(verbs.newSubtask ? [{ label: "Subtask", name: "New subtask", icon: Plus, onClick: act(verbs.newSubtask) }] : []),
    { label: "Archive", icon: Archive, onClick: verbs.archive && act(verbs.archive) },
  ]
  return (
    <div className="flex flex-col gap-2">
      <div className="grid auto-cols-fr grid-flow-col gap-2">
        {tiles.map(({ label, name, icon: Icon, onClick }) => (
          <button
            key={label}
            type="button"
            aria-label={name}
            onClick={onClick ?? undefined}
            disabled={!onClick}
            className={cn(
              "flex h-14 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-surface text-[12px] text-fg-secondary",
              "hover:bg-hover active:bg-hover disabled:opacity-45",
              FOCUS,
            )}
          >
            <Icon aria-hidden className="size-[18px]" />
            {label}
          </button>
        ))}
      </div>
      {verbs.retention && (
        <button
          type="button"
          onClick={act(verbs.retention)}
          className={cn("flex min-h-11 items-center rounded-xl border border-border bg-surface px-3 text-[14px] text-fg-secondary hover:bg-hover active:bg-hover", FOCUS)}
        >
          Export or delete task data…
        </button>
      )}
    </div>
  )
}
