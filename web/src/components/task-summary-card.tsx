import { createContext, useContext, type ReactNode } from "react"

import { Switches } from "@/components/autopilot-pane"
import type { HistoryLinks } from "@/components/autopilot-history-view"
import { BranchRequest, ChevronRight, ChevronUp } from "@/components/icons"
import { Button, StateDot } from "@/components/primitives"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSummaryFolded, useSummaryRows, type SummaryRow } from "@/hooks/useSummaryCard"
import { useTaskSummary, type SummaryModel } from "@/hooks/useTaskSummary"
import { useMinuteTick, useTick } from "@/hooks/useTick"
import { repositoryUrl } from "@/lib/autopilot-history"
import { AUTOPILOT_RAIL_TONE, autopilotReason, autopilotTint } from "@/lib/autopilot-words"
import { externalLinkProps } from "@/lib/external-links"
import { formatTokens } from "@/lib/format"
import { PULL_REQUEST_ICON_TONE, pullRequestIconTone } from "@/lib/pull-request-tone"
import { pullRequestWords } from "@/lib/pull-request-words"
import { elapsed, outcomeWord, pausedOnNetwork, since, stateText } from "@/lib/state"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The summary card in the centre pane's right gutter, beside the reading
 * column (frontend §5n). It sits in its own column of the pane's layout, so
 * it can never cover the transcript or the composer: when the pane is too
 * narrow for both, the shell draws the top bar's chip instead.
 */
export function TaskSummaryGutter({ task, pullRequest, turns }: {
  task: ApiTask
  pullRequest?: PullRequestStatus
  turns: Turn[] | undefined
}) {
  const model = useTaskSummary(task, pullRequest, turns)
  const [, setFolded] = useSummaryFolded()
  return (
    <aside aria-label="Task summary" className="scroll-slim w-[258px] shrink-0 overflow-y-auto pt-3 pr-4.5 pb-3">
      <SummaryCard model={model} onFold={() => setFolded(true)} />
    </aside>
  )
}

/** Rows the gallery draws open, whatever this browser remembers. */
const FixedRows = createContext<readonly SummaryRow[] | null>(null)
/** The phone's task sheet: every row and every control inside one is a 44px thumb target (§6b). */
const Touch = createContext(false)

/**
 * Two quiet boxes: where the task stands (its state, its PR, autopilot), then
 * the session (subtasks, context). In the chip's popover the same rows sit
 * on the popover's own surface, split by a hairline (`floating`).
 */
export function SummaryCard({ model, floating = false, touch = false, openRows, onFold, onDone, footer }: {
  model: SummaryModel
  floating?: boolean
  /** the phone's task sheet: the same rows at touch size */
  touch?: boolean
  /** the gallery's fixed rows, instead of the remembered ones */
  openRows?: readonly SummaryRow[]
  /** the card's own fold control; absent in the popover */
  onFold?: () => void
  /** after a row acted (jumped, opened a task or a tool): the popover closes */
  onDone?: () => void
  footer?: ReactNode
}) {
  const done = (act: () => void) => () => {
    act()
    onDone?.()
  }
  const { task, children } = model
  const session = (children !== null && children.length > 0) || typeof task.context_tokens === "number"
  const box = floating ? "" : "rounded-xl border border-border bg-surface p-1"
  return (
    <FixedRows.Provider value={openRows ?? null}>
      <Touch.Provider value={touch}>
      <div data-testid="task-summary" className={cn("flex flex-col", floating ? "gap-0" : "wisp-summary-card gap-2.5")}>
        <div className={box}>
          <LeadRow model={model} onJump={done(model.onJumpToQuestion)} onFold={onFold} />
          <PullRequestRow pullRequest={model.pullRequest} autopilot={task.autopilot} />
          {model.autopilot && (
            <AutopilotRow model={model.autopilot} pullRequest={model.pullRequest} onOpen={model.onOpenTool && done(() => model.onOpenTool!("autopilot"))} />
          )}
        </div>
        {session && (
          <div className={cn(box, floating && "mt-1 border-t border-border pt-1")}>
            {children !== null && children.length > 0 && (
              <SubtasksRow
                items={children}
                onOpenTask={(id) => done(() => model.onOpenTask(id))()}
                onOpen={model.onOpenTool && done(() => model.onOpenTool!("subtasks"))}
              />
            )}
            {typeof task.context_tokens === "number" && <ContextRow tokens={task.context_tokens}>{model.tokens}</ContextRow>}
          </div>
        )}
        {footer}
      </div>
      </Touch.Provider>
    </FixedRows.Provider>
  )
}

/* ── rows ───────────────────────────────────────────────────────────────── */

const ROW = "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px]"
const ROW_TOUCH = "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[14px] active:bg-hover"
const FOCUS = "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"

/**
 * One fact on one line. A row with more to say opens in place (base-ui
 * Collapsible): the chevron turns and the panel grows to its own height on
 * the motion tokens (index.css, `.wisp-unfold`). Which rows are open is
 * remembered per row, for every task.
 */
function Row({ row, label, value, title, children }: {
  row: SummaryRow
  label: string
  value: ReactNode
  /** the value's hover, when it is truncated */
  title?: string
  /** what the row opens to; none, and it does not open */
  children?: ReactNode
}) {
  const remembered = useSummaryRows()
  const fixed = useContext(FixedRows)
  const touch = useContext(Touch)
  const open = fixed ? fixed.includes(row) : remembered.isOpen(row)
  const rowClass = touch ? ROW_TOUCH : ROW
  const line = (
    <>
      <ChevronRight
        aria-hidden
        className={cn(touch ? "size-3" : "size-2.5", "shrink-0 text-faint", children ? "wisp-turn group-data-panel-open:rotate-90" : "invisible")}
      />
      <span className="shrink-0 text-fg-secondary">{label}</span>
      <span title={title} className="ml-auto flex min-w-0 items-center justify-end gap-1.5 text-muted-foreground tabular-nums">
        {value}
      </span>
    </>
  )
  if (!children) return <div className={rowClass}>{line}</div>
  return (
    <Collapsible open={open} onOpenChange={(next) => !fixed && remembered.set(row, next)}>
      <CollapsibleTrigger className={cn("group hover:bg-hover data-panel-open:bg-hover", rowClass, FOCUS)}>{line}</CollapsibleTrigger>
      <CollapsibleContent className="wisp-unfold">
        <div className={cn("flex flex-col", touch ? "gap-1 pt-1 pr-3 pb-2 pl-8 text-[13px]" : "gap-1.5 pt-1.5 pr-2 pb-2 pl-6 text-[12px]")}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** "Running 1m 07s", "Waiting for you · 1 question", "Done 4 min ago". A waiting question is a button: it scrolls to it. */
function LeadRow({ model, onJump, onFold }: { model: SummaryModel; onJump: () => void; onFold?: () => void }) {
  const { task } = model
  const row = useContext(Touch) ? ROW_TOUCH : ROW
  const running = model.runningSince !== null && task.state === "running"
  // by the second only while a turn runs; "4 min ago" moves by the minute
  const second = useTick(running)
  const minute = useMinuteTick(!running)
  const now = running ? second : minute
  const waiting = task.state === "needs-input"
  const word = waiting ? "Waiting for you" : outcomeWord(task)
  const value = running
    ? elapsed(model.runningSince!, now)
    : waiting
      ? model.questionWaiting ? "1 question" : null
      : model.settledAt && task.state !== "creating" ? since(model.settledAt, now) : null
  const tone = waiting ? "text-state-needs-input" : stateText(task)
  const words = (
    <>
      <StateDot state={task.state} background={task.background} pausedOnNetwork={pausedOnNetwork(task)} />
      <span className={cn("min-w-0 truncate font-medium", tone === "text-muted-foreground" ? "text-foreground" : tone)}>{word}</span>
      {value && <span className={cn("ml-auto shrink-0 tabular-nums", waiting ? tone : "text-muted-foreground")}>{value}</span>}
    </>
  )
  return (
    <div className="flex items-center gap-0.5">
      {waiting ? (
        <button type="button" onClick={onJump} title="Show the question" className={cn(row, FOCUS, "min-w-0 flex-1 hover:bg-hover")}>
          {words}
        </button>
      ) : (
        <div className={cn(row, "min-w-0 flex-1")}>{words}</div>
      )}
      {onFold && (
        <Button size="sm" icon aria-label="Fold into the top bar" title="Fold into the top bar" onClick={onFold} className="mr-0.5">
          <ChevronUp />
        </Button>
      )}
    </div>
  )
}

/** `#318 · Open`; open, it says CI, review and whether it can merge, and links to GitHub. */
function PullRequestRow({ pullRequest, autopilot }: { pullRequest?: PullRequestStatus; autopilot: ApiTask["autopilot"] }) {
  const touch = useContext(Touch)
  if (!pullRequest || pullRequest.kind === "unsupported") return null
  if (pullRequest.kind !== "found") {
    const none = pullRequest.kind === "none"
    return (
      <Row
        row="pull-request"
        label="Pull request"
        title={none ? undefined : "GitHub could not be reached"}
        value={<span className="text-faint">{none ? "None yet" : "Unavailable"}</span>}
      />
    )
  }
  const found = pullRequest.pullRequest
  const words = pullRequestWords(found, autopilot)
  const link = externalLinkProps(found.url)
  return (
    <Row
      row="pull-request"
      label="Pull request"
      title={`PR #${found.number} · ${words.lifecycle} — ${found.title}`}
      value={
        <>
          <BranchRequest aria-hidden className={cn("size-3.5 shrink-0", PULL_REQUEST_ICON_TONE[pullRequestIconTone(found)])} />
          <span className="truncate">#{found.number} · {words.lifecycle}</span>
        </>
      }
    >
      <span className="line-clamp-2 text-foreground">{found.title}</span>
      <span className="text-muted-foreground">{words.checks} · {words.review}</span>
      <span className="text-muted-foreground">{words.mergeState}</span>
      {pullRequest.others ? <span className="text-faint">Newest of {pullRequest.others + 1} on this task</span> : null}
      {link && (
        <a {...link} className={cn("w-fit rounded-sm text-fg-secondary underline-offset-2 hover:text-foreground hover:underline", touch && "flex min-h-11 items-center", FOCUS)}>
          Open on GitHub ↗
        </a>
      )}
    </Row>
  )
}

/** The live reason in the rail's tone; open, the three switches and the way to the panel's history and rounds. */
function AutopilotRow({ model, pullRequest, onOpen }: {
  model: NonNullable<SummaryModel["autopilot"]>
  pullRequest?: PullRequestStatus
  onOpen: (() => void) | null
}) {
  const status = model.switches.status
  const tint = autopilotTint(status)
  const reason = status && tint !== "off" ? autopilotReason(status) : null
  // its lines say "4 min ago": a clock only while they are on screen
  const remembered = useSummaryRows().isOpen("autopilot")
  const fixed = useContext(FixedRows)
  const touch = useContext(Touch)
  const now = useTick(fixed ? fixed.includes("autopilot") : remembered)
  const found = pullRequest?.kind === "found" ? pullRequest.pullRequest : null
  const links: HistoryLinks = {
    repository: repositoryUrl(found?.url),
    pullRequest: found ? { number: found.number, lifecycle: found.lifecycle } : null,
  }
  return (
    <Row
      row="autopilot"
      label="Autopilot"
      title={reason ?? undefined}
      value={reason ? (
        <>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", AUTOPILOT_RAIL_TONE[tint as keyof typeof AUTOPILOT_RAIL_TONE])} />
          <span className={cn("truncate", tint === "needs-you" && "text-destructive")}>{reason}</span>
        </>
      ) : <span className="text-faint">Off</span>}
    >
      {/* the Automation section's own switches, so a flip here and there are one control */}
      <div className={touch ? "-mr-3 -ml-8" : "-mr-2 -ml-6"}>
        <Switches automation={model.switches} reviewable={model.reviewable} touch={touch} now={now} links={links} />
      </div>
      {onOpen && <PanelLink label="Open Autopilot" hint="history, rounds" onClick={onOpen} />}
    </Row>
  )
}

/** `● 1 running · 2`; open, the children, each of which opens. */
function SubtasksRow({ items, onOpenTask, onOpen }: {
  items: NonNullable<SummaryModel["children"]>
  onOpenTask: (id: string) => void
  onOpen: (() => void) | null
}) {
  const waiting = items.filter((child) => child.state === "needs-input").length
  const running = items.filter((child) => child.state === "running").length
  const touch = useContext(Touch)
  const lead = waiting > 0 ? { state: "needs-input" as const, words: `${waiting} waiting` } : running > 0 ? { state: "running" as const, words: `${running} running` } : null
  return (
    <Row
      row="subtasks"
      label="Subtasks"
      value={
        <>
          {lead && <StateDot state={lead.state} />}
          <span className={cn(lead?.state === "needs-input" && "text-state-needs-input")}>{lead ? `${lead.words} · ${items.length}` : items.length}</span>
        </>
      }
    >
      <ul className="-ml-1.5 flex flex-col">
        {items.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              onClick={() => onOpenTask(child.id)}
              className={cn("flex w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-hover", touch ? "h-11 active:bg-hover" : "h-6", FOCUS)}
            >
              <StateDot state={child.state} background={child.background} />
              <span className="min-w-0 flex-1 truncate text-fg-secondary">{child.title}</span>
              {child.subtask_kind && <span className={cn("shrink-0 text-faint", touch ? "text-[12px]" : "text-[11px]")}>{child.subtask_kind}</span>}
            </button>
          </li>
        ))}
      </ul>
      {onOpen && <PanelLink label="Open Subtasks" hint="results, reports" onClick={onOpen} />}
    </Row>
  )
}

/**
 * The tokens the model carries, as of its last call. No gauge: Wisp does not
 * know a model's window, and a bar against a guessed one would be a lie.
 * Open, it is the `/tokens` report.
 */
function ContextRow({ tokens, children }: { tokens: number; children: ReactNode }) {
  return (
    <Row row="context" label="Context" title="conversation the model is carrying, as of its last call" value={formatTokens(tokens)}>
      {children}
    </Row>
  )
}

function PanelLink({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  const touch = useContext(Touch)
  return (
    <button type="button" onClick={onClick} className={cn("-ml-1.5 flex w-[calc(100%+6px)] items-center gap-1 rounded-md px-1.5 text-fg-secondary hover:bg-hover hover:text-foreground", touch ? "h-11 active:bg-hover" : "h-6", FOCUS)}>
      {label}
      <ChevronRight aria-hidden className="size-2.5" />
      <span className={cn("ml-auto text-faint", touch ? "text-[12px]" : "text-[11px]")}>{hint}</span>
    </button>
  )
}
