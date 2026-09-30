import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react"

import type { AutopilotStatus } from "../../../shared/autopilot"
import { History, HistoryLog, PrLink, Sep, Time, type HistoryLinks, type HistoryModel } from "@/components/autopilot-history-view"
import { ChevronDown } from "@/components/icons"
import { Button, PaneHeader, SwitchTrack } from "@/components/primitives"
import { BriefSection, type BriefSectionProps, type Reveal } from "@/components/task-brief"
import { useAutopilot } from "@/hooks/mutations"
import { useAutopilotHistory, useHarnessFeatures, usePullRequestStatus } from "@/hooks/queries"
import { useBriefSwitch } from "@/hooks/useBriefSwitch"
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
} from "@/lib/autopilot-words"
import { briefBand, type BriefBandModel } from "@/lib/brief"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

export type { HistoryLinks } from "@/components/autopilot-history-view"

type Act = "resume" | "send-now" | "skip"
type Change = { autoMerge?: boolean; autoFix?: boolean }

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
 * Two sections in ONE scroller, split by the only full-width line in it:
 *
 *  1. **Brief**, first. It is the part you read, so nothing sits above it but
 *     the tab strip, and nothing caps it (task-brief.tsx).
 *  2. **Automation**: the Auto-merge and Auto-fix switches, the live line and
 *     the one action the state asks for under the switch it speaks for, then
 *     the three latest meaningful events of its History, and "All history",
 *     which swaps the pane for the dense per-PR log.
 *
 * A long brief pushes Automation below the fold. Its header then docks at the
 * foot of the pane with the live line, so a needs-you red is always on
 * screen; clicking it scrolls there, and scrolled into place it is a plain
 * header again. No second scroller, and nothing hidden behind "Show more".
 *
 * A daemon with briefs and no autopilot shows the Brief alone (and the tab is
 * labelled Brief); one with autopilot and no briefs starts with Automation.
 *
 * It used to be a Brief tab, with the switches in the task's `…` menu and
 * their reason as a menu note. A paragraph in a menu is why this tab exists:
 * the menu keeps the switches as shortcuts and nothing else.
 *
 * Kept mounted while another tab shows (`hidden`), like its siblings, so the
 * scroll position, an open comparison and the log survive a look at the diff.
 */
export function AutopilotPane({
  task,
  header,
  hidden = false,
  touch = false,
  onShowConversation,
}: {
  task: ApiTask | null
  /** the panel's tab strip; without one the pane names itself */
  header?: ReactNode
  hidden?: boolean
  touch?: boolean
  /** Bring the transcript on screen before a find or a message reveal runs against it (touch, where it is another tab). */
  onShowConversation?: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const autopilotSupported = features.data?.taskAutopilot === true
  const historySupported = autopilotSupported && features.data?.autopilotHistory === true
  const brief = useBriefSwitch(task)
  const autopilot = useAutopilot()
  const history = useAutopilotHistory(task?.id ?? null, historySupported)
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
  const reveal: Reveal = (words, turn) => onConversation(() => intents.openFind(words, turn))

  const model: BriefBandModel = brief.enabled ? briefBand(brief.query.data, brief.query.error, now) : { kind: "hidden" }
  const briefProps: BriefSectionProps | null = task && brief.available ? {
    switchable: brief.switchable,
    enabled: brief.enabled,
    disabled: brief.disabled,
    // once a report or its empty line is showing, that says the same thing
    note: brief.enabled && model.kind !== "hidden" ? null : brief.note,
    error: brief.error,
    model,
    reportKey: task.id,
    onChange: brief.set,
    onReveal: reveal,
    onRetry: () => void brief.query.refetch(),
  } : null

  const automation: AutomationModel | null = task && autopilotSupported ? {
    status: task.autopilot ?? null,
    locked: task.archived ? "archived" : task.mode === "local" ? "local" : null,
    pending: autopilot.isPending,
    error: autopilot.error ? failureReason(autopilot.error) : null,
    history: historySupported ? { entries: history.data, error: history.error ? failureReason(history.error) : null } : null,
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
      header={header}
      hidden={hidden}
      touch={touch}
      now={now}
      empty={task ? null : "No task selected."}
      brief={briefProps}
      automation={automation}
      links={links}
    />
  )
}

/**
 * The tab from its models alone — which is also how the gallery draws it. It
 * owns only view state: which of its two views shows, and the log's toggles.
 */
export function AutopilotView({
  header,
  hidden = false,
  touch = false,
  now,
  empty = null,
  brief,
  automation,
  links = NO_LINKS,
  initialView = "overview",
}: {
  header?: ReactNode
  hidden?: boolean
  touch?: boolean
  now: number
  /** the one line to show instead, when there is no task */
  empty?: string | null
  brief: BriefSectionProps | null
  automation: AutomationModel | null
  links?: HistoryLinks
  /** the gallery's way to draw the log without a click */
  initialView?: "overview" | "log"
}) {
  const [view, setView] = useState(initialView)
  const [routine, setRoutine] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const entries = automation?.history?.entries
  const log = view === "log" && entries !== undefined && entries.length > 0

  return (
    <div className={cn("h-full min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} aria-hidden={hidden || undefined}>
      {(!touch || header) && (
        <PaneHeader touch={touch} className={header ? "pl-2" : undefined}>
          {header ?? <span className="text-[12.5px] font-medium text-foreground">{automation ? "Autopilot" : "Brief"}</span>}
        </PaneHeader>
      )}
      {log ? (
        <HistoryLog
          entries={entries}
          touch={touch}
          now={now}
          links={links}
          routine={routine}
          onRoutine={setRoutine}
          onBack={() => setView("overview")}
        />
      ) : (
        <div ref={scroller} className="scroll-slim @container relative min-h-0 flex-1 overflow-y-auto">
          {empty ? (
            <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{empty}</p>
          ) : (
            <>
              {brief && <BriefSection {...brief} touch={touch} />}
              {automation && (
                <>
                  {/* a direct child of the scroller, not of the section: a sticky
                      row only docks within its parent, and the section is the
                      part that is below the fold */}
                  <AutomationHead id={headingId} status={automation.status ?? OFF} divider={brief !== null} touch={touch} scroller={scroller} />
                  <section aria-labelledby={headingId}>
                    <Switches automation={automation} touch={touch} now={now} links={links} />
                    {automation.history && (
                      <History history={automation.history} touch={touch} now={now} links={links} onOpen={() => setView("log")} />
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ── the Automation header, and its docked form ─────────────────────────── */

/**
 * True while `target`'s natural place is below `root`'s fold. One observer on
 * a 1px sentinel above the header; a browser without IntersectionObserver
 * never docks, and the header simply scrolls.
 */
function useBelowFold(target: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [below, setBelow] = useState(false)
  useEffect(() => {
    const el = target.current
    const scroller = root.current
    if (!el || !scroller || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      const bottom = entry.rootBounds?.bottom ?? scroller.getBoundingClientRect().bottom
      setBelow(!entry.isIntersecting && entry.boundingClientRect.top >= bottom - 1)
    }, { root: scroller })
    observer.observe(el)
    return () => observer.disconnect()
  }, [target, root])
  return below
}

/**
 * The divider and the section's header, in one row that is `sticky bottom-0`
 * in the tab's scroller: while the section is below the fold it docks at the
 * foot of the pane and says the live line, in the rail's tone.
 */
function AutomationHead({
  id,
  status,
  divider,
  touch,
  scroller,
}: {
  id: string
  status: AutopilotStatus
  divider: boolean
  touch: boolean
  scroller: RefObject<HTMLDivElement | null>
}) {
  const sentinel = useRef<HTMLDivElement>(null)
  const docked = useBelowFold(sentinel, scroller)
  const tint = autopilotTint(status)
  const words = tint === "off" ? "Off" : `${status.about === "pr" && status.pr !== null ? `#${status.pr} · ` : ""}${autopilotReason(status)}`
  const scrollHere = () => {
    const root = scroller.current
    const mark = sentinel.current
    if (!root || !mark) return
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    root.scrollTo?.({ top: mark.offsetTop, behavior: reduced ? "auto" : "smooth" })
  }
  return (
    <>
      <div ref={sentinel} data-automation aria-hidden className="-mb-px h-px" />
      <div
        data-docked={docked || undefined}
        className={cn(
          // opaque, so a docked header hides the brief scrolling under it
          "sticky bottom-0 z-10 flex items-center gap-3 px-3.5",
          touch ? "min-h-12 bg-background" : "h-10 bg-sidebar",
          // the one full-width line in the tab: every other rule is inset
          divider && "border-t border-border-strong",
        )}
      >
        <h2 id={id} className="shrink-0 text-[12.5px] font-semibold text-foreground">Automation</h2>
        {docked && (
          <button
            type="button"
            onClick={scrollHere}
            aria-label={`Show Automation: ${words}`}
            className={cn(
              "-mr-1.5 flex min-w-0 flex-1 items-center justify-end gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors hover:bg-hover",
              "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              touch ? "min-h-11" : "h-7",
              tint === "needs-you" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {tint !== "off" && <TintDot tint={tint} />}
            <span className={cn("truncate", tint === "off" && "text-faint")}>{words}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        )}
      </div>
    </>
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

function Switches({ automation, touch, now, links }: { automation: AutomationModel; touch: boolean; now: number; links: HistoryLinks }) {
  const status = automation.status ?? OFF
  const speaker = autopilotSpeaker(status)
  const disabled = automation.locked !== null || automation.pending
  const action = autopilotAction(automation.status)
  // a round belongs to auto-fix; a pause or a hold to whichever switch speaks
  const actsOn = action === "round" ? "auto-fix" : speaker
  const offReason = autopilotOffReason(automation.status)
  const live = <LiveLine status={status} touch={touch} now={now} links={links} />
  const actions = action && (
    <AutopilotActions status={status} action={action} pending={automation.pending} touch={touch} now={now} act={automation.onAct} />
  )
  const off = (which: "auto-merge" | "auto-fix") => (offReason && status.by === which ? offReason : AUTOPILOT_OFF_WORDS[which])
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
