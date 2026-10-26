import { Popover } from "@base-ui/react/popover"
import { useRef, useState, type ReactNode } from "react"

import { BranchRequest, ChevronDown } from "@/components/icons"
import { POPOVER_SURFACE, StateDot } from "@/components/primitives"
import { SummaryCard } from "@/components/task-summary-card"
import { useSummaryFolded } from "@/hooks/useSummaryCard"
import { useTaskSummary } from "@/hooks/useTaskSummary"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { outcomeWord, pausedOnNetwork } from "@/lib/state"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The summary card folded into the top bar, beside the title (frontend §5n):
 * `● Running · ⎇ #318 ⌄`. The shell draws it instead of the card when the
 * centre pane is too narrow for the card beside the reading column, or when
 * a person folded the card. It opens the same card as a popover, grown from
 * the chip; nothing opens it but a click.
 */
export function TaskSummaryChip({ task, pullRequest, turns, roomy }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  turns: Turn[] | undefined
  /** the pane has room for the card: a folded card can be put back */
  roomy: boolean
}) {
  const [folded, setFolded] = useSummaryFolded()
  return (
    <SummaryChip
      task={task}
      pullRequest={pullRequest}
      popup={(close) => (
        <ChipCard
          task={task}
          pullRequest={pullRequest}
          turns={turns}
          onDone={close}
          footer={folded && roomy ? (
            <button
              type="button"
              onClick={() => {
                close()
                setFolded(false)
              }}
              className="mt-1 flex h-[26px] w-full items-center rounded-lg px-2 text-left text-[12px] text-fg-secondary hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Show beside the conversation
            </button>
          ) : null}
        />
      )}
    />
  )
}

/** The popover's card: its reads start when it opens, and stop when it closes. */
function ChipCard({ task, pullRequest, turns, onDone, footer }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  turns: Turn[] | undefined
  onDone: () => void
  footer: ReactNode
}) {
  const model = useTaskSummary(task, pullRequest, turns)
  return <SummaryCard model={model} floating onDone={onDone} footer={footer} />
}

/** The chip and its popover, from the task alone; the gallery opens it with `defaultOpen`. */
export function SummaryChip({ task, pullRequest, popup, defaultOpen = false }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  popup: (close: () => void) => ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const popupRef = useRef<HTMLDivElement>(null)
  const found = pullRequest?.kind === "found" ? pullRequest.pullRequest : null
  const waiting = task.state === "needs-input"
  const word = waiting ? "Waiting for you" : outcomeWord(task)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Task summary: ${word}${found ? ` · PR #${found.number}` : ""}`}
        className={cn(
          "flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] whitespace-nowrap text-fg-secondary",
          "transition-colors hover:bg-hover hover:text-foreground data-[popup-open]:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
        <StateDot state={task.state} background={task.background} pausedOnNetwork={pausedOnNetwork(task)} />
        <span className={cn(waiting && "text-state-needs-input")}>{word}</span>
        {found && (
          <>
            <span aria-hidden className="text-faint">·</span>
            <BranchRequest aria-hidden className={cn("size-3.5", PULL_REQUEST_ICON_TONE[pullRequestIconTone(found)])} />
            <span className="tabular-nums">#{found.number}</span>
          </>
        )}
        <ChevronDown aria-hidden className="size-3 text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="z-(--z-menu)">
          <Popover.Popup
            ref={popupRef}
            aria-label="Task summary"
            // a pointer lands on the popup, so no row wears a focus ring it did not ask for; the keyboard lands on the first row
            initialFocus={(type) => (type === "keyboard" ? true : popupRef.current)}
            className={cn(POPOVER_SURFACE, "w-[264px] max-w-[calc(100vw-24px)] rounded-xl p-1 outline-none")}>
            {popup(() => setOpen(false))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
