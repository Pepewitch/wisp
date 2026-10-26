import { useId, useState, type ReactNode } from "react"

import type { AutopilotStatus, AutopilotUpdate } from "../../../shared/autopilot"
import { Reviews, type ReviewsModel } from "@/components/auto-review-view"
import { History, HistoryLog, PrLink, Sep, Time, type HistoryLinks, type HistoryModel } from "@/components/autopilot-history-view"
import { Button, PaneHeader, SwitchTrack } from "@/components/primitives"
import { useAutopilot } from "@/hooks/mutations"
import { useAutopilotHistory, useAutoReviewRounds, useHarnessFeatures, usePullRequestStatus } from "@/hooks/queries"
import { useTick } from "@/hooks/useTick"
import { failureReason } from "@/lib/api"
import { repositoryUrl } from "@/lib/autopilot-history"
import {
  AUTOPILOT_OFF_WORDS,
  AUTOPILOT_RAIL_TONE,
  autopilotAction,
  autopilotOffReason,
  autopilotReason,
  autopilotSpeaker,
  autopilotTint,
  fixRoundsWords,
  reviewRoundsWords,
} from "@/lib/autopilot-words"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask, HarnessesResponse } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

export type { HistoryLinks } from "@/components/autopilot-history-view"

type Act = "resume" | "send-now" | "skip"
type Change = AutopilotUpdate

/** The Automation section's inputs: what the task row says, and what this surface may do about it. */
export interface AutomationModel {
  /** null until the task was ever armed */
  status: AutopilotStatus | null
  /** why the switches cannot move here: a local task has no PR of its own, an archived one is done */
  locked: "local" | "archived" | null
  pending: boolean
  error: string | null
  /** null on a daemon without `features.autopilotHistory`: the sub-section is not drawn at all */
  history: HistoryModel | null
  /**
   * null on a daemon without `features.autoReview`: no third switch and no
   * Reviews block. Otherwise the current PR's rounds, shown while it is on.
   */
  reviews?: ReviewsModel | null
  onSet: (change: Change) => void
  onAct: (act: Act) => void
}

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, pr: null, state: "off", reason: "", about: "task", by: "auto-merge",
  mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
}
const NO_LINKS: HistoryLinks = { repository: null, pullRequest: null }

/**
 * The Autopilot tab: the first tab of the task panel (frontend reference §5k).
 * One section, **Automation**, in one scroller: the Auto-merge, Auto-fix and
 * Auto-review switches, the live line and the one action the state asks for
 * under the switch it speaks for, then auto-review's rounds for the PR
 * (Reviews), then the three latest meaningful events of its History, and
 * "All history", which swaps the pane for the dense per-PR log.
 *
 * The switches used to live in the task's `…` menu, with their reason as a
 * menu note. A paragraph in a menu is why this tab exists: the menu keeps the
 * switches as shortcuts and nothing else.
 *
 * Kept mounted while another tool shows (`hidden`), like its siblings, so the
 * scroll position, an open comparison and the log survive a look at the diff.
 */
export function AutopilotPane({
  task,
  hidden = false,
  touch = false,
  onShowConversation,
  onClose,
}: {
  task: ApiTask | null
  hidden?: boolean
  touch?: boolean
  /** Bring the transcript on screen before a message reveal runs against it (touch, where it is another tab). */
  onShowConversation?: () => void
  /** the tool panel's close control */
  onClose?: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const autopilotSupported = features.data?.taskAutopilot === true
  const historySupported = autopilotSupported && features.data?.autopilotHistory === true
  const autopilot = useAutopilot()
  const history = useAutopilotHistory(task?.id ?? null, historySupported)
  const reviews = useReviewsModel(task, autopilotSupported, features.data, connectionId)
  // the header's PR read: one key, so this is the request it already makes
  const pullRequest = usePullRequestStatus(autopilotSupported ? task?.id ?? null : null).data
  // relative times and a round's countdown, only while the tab is on screen
  const now = useTick(!hidden)

  const intents = uiIntentsFor(connectionId)
  const onConversation = (then: () => void) => {
    if (!onShowConversation) return then()
    onShowConversation()
    // a frame later, so the conversation it acts on is on screen
    requestAnimationFrame(then)
  }

  const automation: AutomationModel | null = task && autopilotSupported ? {
    status: task.autopilot ?? null,
    locked: task.archived ? "archived" : task.mode === "local" ? "local" : null,
    pending: autopilot.isPending,
    error: autopilot.error ? failureReason(autopilot.error) : null,
    history: historySupported ? { entries: history.data, error: history.error ? failureReason(history.error) : null } : null,
    reviews,
    onSet: (change) => autopilot.mutate({ id: task.id, set: change }),
    onAct: (act) => autopilot.mutate({ id: task.id, act }),
  } : null

  const found = pullRequest?.kind === "found" ? pullRequest.pullRequest : null
  const links: HistoryLinks = {
    repository: repositoryUrl(found?.url),
    pullRequest: found ? { number: found.number, lifecycle: found.lifecycle } : null,
    onViewMessage: (messageId) => onConversation(() => intents.revealMessage(messageId)),
  }

  return (
    <AutopilotView
      onClose={onClose}
      hidden={hidden}
      touch={touch}
      now={now}
      empty={task ? null : "No task selected."}
      automation={automation}
      links={links}
    />
  )
}

/**
 * Auto-review's rounds for the Automation section, or null on a daemon
 * without `features.autoReview` (no third switch, no Reviews). The rounds are
 * asked for only while the switch is on, because only then are they drawn.
 */
function useReviewsModel(
  task: ApiTask | null,
  autopilotSupported: boolean,
  features: HarnessesResponse["features"],
  connectionId: string,
): ReviewsModel | null {
  const supported = autopilotSupported && features?.autoReview === true
  const rounds = useAutoReviewRounds(task?.id ?? null, supported && task?.autopilot?.autoReview === true)
  if (!supported) return null
  return {
    rounds: rounds.data,
    error: rounds.error ? failureReason(rounds.error) : null,
    // a reviewer is a task like any other: selecting it is the desktop's focus request
    onOpenTask: (id) => uiIntentsFor(connectionId).focusTask(id),
    panel: features?.reviewPanel === true,
    capture: features?.capture === true,
  }
}

/**
 * The tab from its models alone — which is also how the gallery draws it. It
 * owns only view state: which of its two views shows, and the log's toggles.
 */
export function AutopilotView({
  onClose,
  hidden = false,
  touch = false,
  now,
  empty = null,
  automation,
  links = NO_LINKS,
  initialView = "overview",
}: {
  onClose?: () => void
  hidden?: boolean
  touch?: boolean
  now: number
  /** the one line to show instead, when there is no task */
  empty?: string | null
  automation: AutomationModel | null
  links?: HistoryLinks
  /** the gallery's way to draw the log without a click */
  initialView?: "overview" | "log"
}) {
  const [view, setView] = useState(initialView)
  const [routine, setRoutine] = useState(false)
  const headingId = useId()
  const entries = automation?.history?.entries
  const log = view === "log" && entries !== undefined && entries.length > 0

  return (
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      {/* on touch the back row above it already names it */}
      {!touch && (
        <PaneHeader onClose={onClose} closeLabel="Autopilot">
          <span className="text-[12.5px] font-medium text-foreground">Autopilot</span>
        </PaneHeader>
      )}
      {log && (
        <HistoryLog
          entries={entries}
          touch={touch}
          now={now}
          links={links}
          routine={routine}
          onRoutine={setRoutine}
          onBack={() => setView("overview")}
        />
      )}
      {/* kept mounted under the log, as the tabs keep their panes: back
          returns to the same scroll position and an open comparison */}
      <div className={cn("scroll-slim @container relative min-h-0 flex-1 overflow-y-auto", log && "hidden")}>
          {empty ? (
            <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{empty}</p>
          ) : automation && (
            <section aria-labelledby={headingId}>
              <div className={cn("flex items-center px-3.5", touch ? "min-h-12" : "h-10")}>
                <h2 id={headingId} className="text-[12.5px] font-semibold text-foreground">Automation</h2>
              </div>
              <Switches automation={automation} reviewable={automation.reviews != null} touch={touch} now={now} links={links} />
              {automation.reviews && automation.status?.autoReview && (
                <Reviews reviews={automation.reviews} pr={automation.status.pr} touch={touch} now={now} />
              )}
              {automation.history && (
                <History history={automation.history} touch={touch} now={now} links={links} onOpen={() => setView("log")} />
              )}
            </section>
          )}
      </div>
    </div>
  )
}

function TintDot({ tint, className }: { tint: "needs-you" | "done" | "on" | "off"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", tint === "off" ? "bg-border-strong" : AUTOPILOT_RAIL_TONE[tint], className)}
    />
  )
}

/* ── the switches ───────────────────────────────────────────────────────── */

/** What the switches need: the Automation section's model without its history and rounds. */
export type SwitchesModel = Pick<AutomationModel, "status" | "locked" | "pending" | "error" | "onSet" | "onAct">

/**
 * The three switches, each with the line under it and the one action the
 * state asks for. The Automation section draws them, and so does the summary
 * card's Autopilot row when it is open (task-summary-card.tsx).
 */
export function Switches({ automation, reviewable, touch, now, links }: {
  automation: SwitchesModel
  /** the daemon has auto-review: a third switch */
  reviewable: boolean
  touch: boolean
  now: number
  links: HistoryLinks
}) {
  const status = automation.status ?? OFF
  const speaker = autopilotSpeaker(status)
  const disabled = automation.locked !== null || automation.pending
  const action = autopilotAction(automation.status)
  const review = status.autoReview === true
  // a round belongs to auto-fix; a pause or a hold to whichever switch speaks
  const actsOn = action === "round" ? "auto-fix" : speaker
  const offReason = autopilotOffReason(automation.status)
  const live = <LiveLine status={status} touch={touch} now={now} links={links} />
  const actions = action && (
    <AutopilotActions status={status} action={action} pending={automation.pending} touch={touch} now={now} act={automation.onAct} />
  )
  const off = (which: "auto-merge" | "auto-fix" | "auto-review") => (offReason && status.by === which ? offReason : AUTOPILOT_OFF_WORDS[which])
  return (
    <div className="pb-1">
      {automation.locked === "local" && (
        <p className="px-3.5 pb-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Needs a worktree task: this one runs in the project checkout.
        </p>
      )}
      <SwitchRow
        name="Auto-merge"
        on={status.autoMerge}
        disabled={disabled}
        touch={touch}
        onChange={() => automation.onSet({ autoMerge: !status.autoMerge })}
        actions={status.autoMerge && actsOn === "auto-merge" ? actions : null}
      >
        {!status.autoMerge ? off("auto-merge") : speaker === "auto-merge" ? live : (
          <>On · {status.pr !== null ? <>merges <PrLink number={status.pr} links={links} touch={touch} /> once it is ready</> : "for the task's next PR"}</>
        )}
      </SwitchRow>
      <SwitchRow
        name="Auto-fix"
        on={status.autoFix}
        disabled={disabled}
        touch={touch}
        onChange={() => automation.onSet({ autoFix: !status.autoFix })}
        actions={status.autoFix && actsOn === "auto-fix" ? actions : null}
      >
        {!status.autoFix ? off("auto-fix") : speaker === "auto-fix" ? live : (
          <>On · {status.pr === null ? "for the task's next PR" : fixRoundsWords(status.fixRounds)}</>
        )}
      </SwitchRow>
      {reviewable && (
        <SwitchRow
          name="Auto-review"
          on={review}
          disabled={disabled}
          touch={touch}
          onChange={() => automation.onSet({ autoReview: !review })}
          actions={review && actsOn === "auto-review" ? actions : null}
        >
          {!review ? off("auto-review") : speaker === "auto-review" ? live : (
            <>On · {status.pr === null ? "for the task's next PR" : reviewRoundsWords(status.reviewRounds ?? 0)}</>
          )}
        </SwitchRow>
      )}
      {automation.error && (
        <p role="alert" className="px-3.5 pt-1 pb-1.5 text-[11.5px] leading-relaxed text-destructive">{automation.error}</p>
      )}
    </div>
  )
}

/** One switch: the top line is the hit target, the line under it says what it does (off) or what it is doing (on). */
function SwitchRow({
  name,
  on,
  disabled,
  touch,
  onChange,
  actions,
  children,
}: {
  name: string
  on: boolean
  disabled: boolean
  touch: boolean
  onChange: () => void
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <div className="px-3.5 py-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        disabled={disabled}
        onClick={onChange}
        className={cn(
          "-mx-1.5 flex w-[calc(100%+12px)] items-center justify-between gap-3 rounded-md px-1.5 text-left transition-colors hover:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
          touch ? "min-h-11" : "h-7",
        )}
      >
        <span className={cn("font-medium text-foreground", touch ? "text-[13px]" : "text-[12.5px]")}>{name}</span>
        <SwitchTrack checked={on} />
      </button>
      <div className="pr-9 text-[11.5px] leading-relaxed text-muted-foreground">{children}</div>
      {actions && <div className={cn("flex flex-wrap items-center gap-1.5", touch ? "mt-2 mb-1" : "mt-1.5 mb-0.5")}>{actions}</div>}
    </div>
  )
}

/** The live line: a dot in the sidebar rail's tone, the PR it is bound to, the reason, and how long it has stood. */
function LiveLine({ status, touch, now, links }: { status: AutopilotStatus; touch: boolean; now: number; links: HistoryLinks }) {
  const tint = autopilotTint(status)
  // only a reason about the PR itself names it; one about the task never does
  const pr = status.about === "pr" ? status.pr : null
  return (
    <span data-tint={tint} className={cn(tint === "needs-you" && "text-destructive")}>
      <TintDot tint={tint} className="mr-1.5 inline-block align-[1px]" />
      {pr !== null && <><PrLink number={pr} links={links} touch={touch} /><Sep /></>}
      {autopilotReason(status)}
      {status.updatedAt && (
        <span className="whitespace-nowrap text-faint">
          <Sep />
          <Time at={status.updatedAt} now={now} />
        </span>
      )}
    </span>
  )
}

/** Same rules as the menu rows they replace: one action, the one the state asks for. */
function AutopilotActions({
  status,
  action,
  pending,
  touch,
  now,
  act,
}: {
  status: AutopilotStatus
  action: "resume" | "continue" | "round"
  pending: boolean
  touch: boolean
  now: number
  act: (action: Act) => void
}) {
  const size = touch ? "touch" : "sm"
  if (action === "resume") return <Button tone="outline" size={size} disabled={pending} onClick={() => act("resume")}>Resume</Button>
  if (action === "continue") return <Button tone="outline" size={size} disabled={pending} onClick={() => act("resume")}>Continue now</Button>
  return (
    <>
      <Button tone="outline" size={size} disabled={pending} onClick={() => act("send-now")}>Send now</Button>
      <Button size={size} disabled={pending} onClick={() => act("skip")}>Skip</Button>
      {status.pendingFix && <span className="text-[11px] text-faint">{sendsIn(status.pendingFix.sendsAt, now)}</span>}
    </>
  )
}

function sendsIn(at: string, now: number): string {
  const seconds = Math.ceil((Date.parse(at) - now) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return "sending…"
  return seconds < 60 ? `sends in ${seconds}s` : `sends in ${Math.ceil(seconds / 60)} min`
}
