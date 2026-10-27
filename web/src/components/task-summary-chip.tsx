import { Popover } from "@base-ui/react/popover"
import { useRef, useState, type ReactNode } from "react"

import { BranchRequest, ChevronDown } from "@/components/icons"
import { POPOVER_SURFACE } from "@/components/primitives"
import { SummaryCard } from "@/components/task-summary-card"
import { useSummaryFolded } from "@/hooks/useSummaryCard"
import { useTaskSummary } from "@/hooks/useTaskSummary"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { outcomeWord } from "@/lib/state"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The summary card folded into the top bar, beside the title (frontend §5n):
 * `Running · ⎇ #318 ⌄`. The state's dot stays with the title, before it. The shell draws it instead of the card when the
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
export function SummaryChip({ task, pullRequest, popup, defaultOpen = false, popupClassName }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  popup: (close: () => void) => ReactNode
  defaultOpen?: boolean
  /** the gallery's tighter cap, so an open frame stays inside its own box */
  popupClassName?: string
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
          "wisp-chip flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] whitespace-nowrap text-fg-secondary",
          "transition-colors hover:bg-hover hover:text-foreground data-[popup-open]:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
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
        {/* It hangs from the top bar, so there is never room above: it keeps its
            side and scrolls within the height left below it instead of flipping. */}
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          collisionAvoidance={{ side: "none", align: "shift" }}
          className="z-(--z-menu)"
        >
          <Popover.Popup
            ref={popupRef}
            aria-label="Task summary"
            // a pointer lands on the popup, so no row wears a focus ring it did not ask for; the keyboard lands on the first row
            initialFocus={(type) => (type === "keyboard" ? true : popupRef.current)}
            className={cn(POPOVER_SURFACE, "scroll-slim max-h-(--available-height) w-[264px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl p-1 outline-none", popupClassName)}>
            {popup(() => setOpen(false))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
