import { useMemo, useState, type ReactNode } from "react"

import type { AutopilotHistoryEntry } from "../../../shared/autopilot"
import type { PullRequestLifecycle } from "../../../shared/api/pull-requests"
import { ChevronLeft, ChevronRight } from "@/components/icons"
import { Rule, SwitchTrack } from "@/components/primitives"
import {
  groupHistory,
  historyDetail,
  historyTitle,
  historyTone,
  historyWord,
  logDetail,
  plural,
  recentHistory,
  runLabel,
  shortSha,
  type HistoryGroup,
  type HistoryTone,
} from "@/lib/autopilot-history"
import { externalLinkProps } from "@/lib/external-links"
import { fromNow, utcIso } from "@/lib/time"
import { cn } from "@/lib/utils"

/*
 * The Autopilot tab's History (autopilot-pane.tsx): the three latest
 * meaningful events under the switches, and the dense per-PR log behind
 * "All history". The words come from lib/autopilot-history.ts.
 */

/** The History sub-section's data: undefined entries while the first read is in flight. */
export interface HistoryModel {
  entries: AutopilotHistoryEntry[] | undefined
  error: string | null
}

/** Where a PR number and a commit lead, known from the task's own pull request. */
export interface HistoryLinks {
  /** `https://github.com/<owner>/<repo>`; null keeps numbers and SHAs plain text */
  repository: string | null
  /** the task's current PR, so its section in the log can say Open, Draft or Closed */
  pullRequest: { number: number; lifecycle: PullRequestLifecycle } | null
  /** "View message": scroll the conversation to the message an auto-fix round queued */
  onViewMessage?: (messageId: string) => void
}

/* ── History: the three latest, and the way into all of it ─────────────── */

export function History({
  history,
  touch,
  now,
  links,
  onOpen,
}: {
  history: HistoryModel
  touch: boolean
  now: number
  links: HistoryLinks
  onOpen: () => void
}) {
  const entries = history.entries
  const recent = useMemo(() => (entries ? recentHistory(entries) : []), [entries])
  return (
    <div className="pb-3">
      <div className="flex items-center gap-3 px-3.5 pt-3 pb-1">
        <h3 className="shrink-0 text-[11.5px] font-medium text-fg-secondary">History</h3>
        <Rule />
      </div>
      {entries === undefined ? (
        <p role={history.error ? "alert" : "status"} className="px-3.5 pt-1 text-[11.5px] text-faint">
          {history.error ?? "Loading history…"}
        </p>
      ) : entries.length === 0 ? (
        <p className="px-3.5 pt-1 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">
          Nothing yet. Once Auto-merge or Auto-fix is on, every check, fix round and merge lands here, newest first.
        </p>
      ) : (
        <div className="px-3.5">
          <ul className="ml-[3px]">
            {recent.map(({ entry, round }, i) => (
              <EntryRow key={`${entry.at}:${i}`} entry={entry} round={round} touch={touch} now={now} links={links} />
            ))}
          </ul>
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "-mx-1.5 mt-1 flex w-[calc(100%+12px)] items-center justify-between rounded-md px-1.5 text-[12px] text-fg-secondary transition-colors hover:bg-hover hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              touch ? "min-h-11" : "h-7",
            )}
          >
            <span>
              All history <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">{entries.length}</span>
            </span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </button>
        </div>
      )}
    </div>
  )
}

/** One event, two lines: the word you scan down, then the detail with its links. */
function EntryRow({ entry, round, touch, now, links }: { entry: AutopilotHistoryEntry; round?: number; touch: boolean; now: number; links: HistoryLinks }) {
  const tone = historyTone(entry.kind)
  const detail = historyDetail(entry)
  const message = entry.messageId && links.onViewMessage ? entry.messageId : null
  // inline in a wrapped line: a 44px floor would open a gap in the text, so touch gets padding instead
  const inline = touch ? "py-1" : undefined
  const extras = [
    ...(message ? [<QuietButton key="message" touch={false} className={inline} onClick={() => links.onViewMessage!(message)}>View message</QuietButton>] : []),
    ...(entry.sha ? [<ShaLink key="sha" sha={entry.sha} links={links} touch={false} className={inline} />] : []),
  ]
  return (
    <li className={cn("grid grid-cols-[6px_minmax(0,1fr)_auto] items-baseline gap-x-2.5", touch ? "py-1.5" : "py-1")}>
      <Dot tone={tone} className="mt-[7px] self-start" />
      <div className="min-w-0">
        <div className={cn("text-[12.5px]", tone === "routine" ? "text-muted-foreground" : "text-foreground")}>{historyTitle(entry, round)}</div>
        {(detail || extras.length > 0) && (
          <div className="text-[11.5px] leading-relaxed text-muted-foreground">
            {detail}
            {extras.map((extra, i) => (
              <span key={i} className="whitespace-nowrap">{(detail || i > 0) && <Sep />}{extra}</span>
            ))}
          </div>
        )}
      </div>
      <Time at={entry.at} now={now} className="text-[11px] text-faint" />
    </li>
  )
}

/* ── All history: the dense per-PR log ──────────────────────────────────── */

const LIFECYCLE_WORD: Record<PullRequestLifecycle, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

/**
 * Every entry the daemon keeps, one line each, in sections per PR with sticky
 * headers. Routine waits fold into one line per run ("Waiting · for checks
 * ×7"); a click opens one run, and "Routine checks" opens them all. The back
 * row is the Workflows pane's drill-down pattern: no second tablist.
 */
export function HistoryLog({
  entries,
  touch,
  now,
  links,
  routine,
  onRoutine,
  onBack,
}: {
  entries: AutopilotHistoryEntry[]
  touch: boolean
  now: number
  links: HistoryLinks
  routine: boolean
  onRoutine: (routine: boolean) => void
  onBack: () => void
}) {
  const groups = useMemo(() => groupHistory(entries), [entries])
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  return (
    <>
      <div className={cn("flex shrink-0 items-center justify-between border-b border-border px-2", touch ? "h-11" : "h-7")}>
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "flex h-full items-center gap-1 px-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
        >
          <ChevronLeft className="size-3" />
          Autopilot
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={routine}
          onClick={() => onRoutine(!routine)}
          className={cn(
            "flex h-full items-center gap-2 px-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
        >
          Routine checks
          <SwitchTrack checked={routine} />
        </button>
      </div>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto pb-3">
        {groups.map((group, g) => (
          <section key={`${group.pr ?? "next"}:${g}`} aria-label={group.pr === null ? "Next PR" : `PR #${group.pr}`}>
            <GroupHeader group={group} touch={touch} links={links} />
            <ul className="px-1.5 pt-0.5">
              {group.items.map((item, i) => {
                if (item.kind === "one") return <LogRow key={i} entry={item.entry} round={item.round} touch={touch} now={now} links={links} />
                const id = `${g}:${i}`
                if (routine || opened.has(id)) {
                  return item.entries.map((entry, j) => <LogRow key={`${i}:${j}`} entry={entry} touch={touch} now={now} links={links} />)
                }
                return (
                  <FoldedRun
                    key={i}
                    entries={item.entries}
                    touch={touch}
                    now={now}
                    onOpen={() => setOpened((current) => new Set([...current, id]))}
                  />
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

function GroupHeader({ group, touch, links }: { group: HistoryGroup; touch: boolean; links: HistoryLinks }) {
  const lifecycle = !group.merged && group.pr !== null && links.pullRequest?.number === group.pr ? LIFECYCLE_WORD[links.pullRequest.lifecycle] : null
  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex items-center gap-2 border-b border-border px-3.5 text-[11.5px]",
        touch ? "h-9 bg-background" : "h-7 bg-sidebar",
      )}
    >
      {group.pr === null ? (
        <span className="font-medium text-fg-secondary">Next PR</span>
      ) : (
        <>
          <span className="font-medium text-foreground"><PrLink number={group.pr} links={links} touch={false} strong /></span>
          {(group.merged || lifecycle) && <span className="text-faint">·</span>}
          {group.merged ? (
            <span className="flex items-center gap-1.5 text-muted-foreground"><Dot tone="merge" />{historyWord(group.merged)}</span>
          ) : lifecycle ? (
            <span className="text-muted-foreground">{lifecycle}</span>
          ) : null}
        </>
      )}
      <span className="ml-auto text-[11px] text-faint">
        {group.rounds > 0 && `${plural(group.rounds, "fix round")} · `}
        {plural(group.events, "event")}
      </span>
    </div>
  )
}

const LOG_ROW = "grid grid-cols-[44px_6px_92px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded px-2"

function LogRow({ entry, round, touch, now, links }: { entry: AutopilotHistoryEntry; round?: number; touch: boolean; now: number; links: HistoryLinks }) {
  const tone = historyTone(entry.kind)
  const message = entry.messageId && links.onViewMessage ? entry.messageId : null
  return (
    <li title={entry.detail} className={cn(LOG_ROW, "hover:bg-hover", touch ? "min-h-11" : "h-6")}>
      <Time at={entry.at} now={now} short className="text-right text-[11px] text-faint" />
      <Dot tone={tone} />
      <span className={cn("truncate text-[12px]", tone === "routine" ? "text-muted-foreground" : "text-foreground")}>{historyWord(entry, round)}</span>
      <span className="truncate text-[11.5px] text-muted-foreground">{logDetail(entry)}</span>
      <span className="flex items-center gap-2">
        {message && <QuietButton touch={touch} onClick={() => links.onViewMessage!(message)}>Message</QuietButton>}
        {entry.sha && <ShaLink sha={entry.sha} links={links} touch={touch} />}
      </span>
    </li>
  )
}

function FoldedRun({ entries, touch, now, onOpen }: { entries: AutopilotHistoryEntry[]; touch: boolean; now: number; onOpen: () => void }) {
  const newest = entries[0]!
  const oldest = entries.at(-1)!
  return (
    <li>
      <button
        type="button"
        aria-expanded={false}
        onClick={onOpen}
        title={`${entries.length} checks, ${utcIso(oldest.at)} to ${utcIso(newest.at)}`}
        className={cn(
          LOG_ROW,
          "w-full text-left text-[11.5px] text-faint transition-colors hover:bg-hover",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          touch ? "min-h-11" : "h-6",
        )}
      >
        <Time at={newest.at} now={now} short className="text-right text-[11px]" />
        <Dot tone="routine" />
        <span className="text-[12px] text-muted-foreground">Waiting</span>
        <span className="truncate">
          {runLabel(entries)} <span className="font-mono text-[10.5px]">×{entries.length}</span>
        </span>
      </button>
    </li>
  )
}

/* ── small pieces ───────────────────────────────────────────────────────── */

const DOT: Record<HistoryTone, string> = {
  merge: "bg-primary",
  merging: "border-[1.5px] border-primary bg-transparent",
  alert: "bg-destructive",
  event: "bg-muted-foreground",
  routine: "bg-border-strong",
}

function Dot({ tone, className }: { tone: HistoryTone; className?: string }) {
  return <span aria-hidden data-tone={tone} className={cn("size-1.5 shrink-0 rounded-full", DOT[tone], className)} />
}

export function Sep() {
  return <span aria-hidden className="mx-1.5 text-faint">·</span>
}

/** Relative, with the exact UTC instant on hover — the same as the Workflows history. */
export function Time({ at, now, short = false, className }: { at: string; now: number; short?: boolean; className?: string }) {
  const words = fromNow(at, now)
  return (
    <time dateTime={at} title={utcIso(at)} className={cn("shrink-0 tabular-nums", className)}>
      {short ? words.replace(/ ago$/, "") : words}
    </time>
  )
}

const QUIET_LINK = "rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"

function QuietButton({ children, onClick, touch, className }: { children: ReactNode; onClick: () => void; touch: boolean; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn(QUIET_LINK, "inline-flex items-center text-[11.5px] text-muted-foreground", touch && "min-h-11", className)}>
      {children}
    </button>
  )
}

/** `#318`: the PR on GitHub when its repository is known, plain text otherwise. */
export function PrLink({ number, links, touch, strong = false }: { number: number; links: HistoryLinks; touch: boolean; strong?: boolean }) {
  const anchor = links.repository ? externalLinkProps(`${links.repository}/pull/${number}`) : null
  const color = strong ? "text-foreground" : "text-muted-foreground"
  if (!anchor) return <span className={color}>#{number}</span>
  return <a {...anchor} className={cn(QUIET_LINK, color, touch && "py-0.5")}>#{number}</a>
}

/** A seven-character SHA in mono: the commit on GitHub when the repository is known. */
function ShaLink({ sha, links, touch, className }: { sha: string; links: HistoryLinks; touch: boolean; className?: string }) {
  const anchor = links.repository ? externalLinkProps(`${links.repository}/commit/${sha}`) : null
  const text = <span className="font-mono text-[10.5px]">{shortSha(sha)}</span>
  if (!anchor) return <span title={sha} className="text-fg-secondary">{text}</span>
  return <a {...anchor} title={sha} className={cn(QUIET_LINK, "inline-flex items-center text-fg-secondary", touch && "min-h-11", className)}>{text}</a>
}
