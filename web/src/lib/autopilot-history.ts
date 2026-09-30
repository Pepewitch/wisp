import type { AutopilotHistoryEntry } from "../../../shared/autopilot"

/**
 * The Autopilot tab's history, from the daemon's entries alone (newest first,
 * as `GET /api/tasks/:id/autopilot/history` serves them). Pure, so the tab,
 * its drill-in log and the gallery all read the same words.
 *
 * The daemon's `detail` is a sentence written for `wisp pr <task> history`.
 * Here the event WORD is the left edge you scan down ("Merge failed", "Fix
 * round 2"), and the detail loses what the row already says elsewhere: the PR
 * (its group header), and the head commit (a link of its own).
 */

/** The dot's tone. The words stay gray or foreground; only the dot carries colour. */
export type HistoryTone = "merge" | "merging" | "alert" | "event" | "routine"

const TONE: Record<string, HistoryTone> = {
  merged: "merge",
  merging: "merging",
  blocked: "alert",
  "merge-failed": "alert",
  paused: "alert",
  "judge-unavailable": "alert",
  wait: "routine",
  active: "routine",
  configured: "routine",
}

export function historyTone(kind: string): HistoryTone {
  return TONE[kind] ?? "event"
}

/** Everything but the routine: what the tab's short History shows. */
export function isMeaningful(entry: AutopilotHistoryEntry): boolean {
  return historyTone(entry.kind) !== "routine"
}

const WORD: Record<string, string> = {
  armed: "Switched on",
  configured: "Switches changed",
  bound: "Watching",
  wait: "Waiting",
  blocked: "Needs you",
  rerun: "Reran a check",
  judged: "Review judged",
  "judge-unavailable": "Review judge gave up",
  wake: "Fix round",
  skipped: "Fix round skipped",
  held: "Held by Stop",
  resumed: "Resumed",
  merging: "Merging",
  merged: "Merged by Wisp",
  "merge-failed": "Merge failed",
  active: "Active",
  paused: "Paused",
  completed: "Switched off",
}

/** A merge somebody else made reads `#7 was merged into main`; Wisp's own reads `Merged #7 into main`. */
function mergedBySomeoneElse(entry: AutopilotHistoryEntry): boolean {
  return entry.kind === "merged" && /^#\d+ was merged\b/.test(entry.detail)
}

/** The event word for the dense log's one-line rows: `Fix round 2`, `Watching`, `Merge failed`. */
export function historyWord(entry: AutopilotHistoryEntry, round?: number): string {
  if (entry.kind === "wake") return round ? `Fix round ${round}` : "Fix round"
  if (mergedBySomeoneElse(entry)) return "Merged"
  return WORD[entry.kind] ?? entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1).replace(/-/g, " ")
}

/** The two-line entry's title: a round says it was sent, and a watch names its PR. */
export function historyTitle(entry: AutopilotHistoryEntry, round?: number): string {
  if (entry.kind === "wake") return round ? `Fix round ${round} sent` : "Fix round sent"
  if (entry.kind === "bound" && entry.pr !== null) return `Watching #${entry.pr}`
  return historyWord(entry, round)
}

/** The daemon's sentence without the parts the row already says; null when nothing is left. */
export function historyDetail(entry: AutopilotHistoryEntry): string | null {
  const detail = entry.detail
  const rest = (() => {
    switch (entry.kind) {
      case "bound":
      case "resumed":
        return ""
      case "merged":
        return detail.replace(/^Merged #\d+ /, "").replace(/^#\d+ was merged /, "")
      case "merging":
        return detail.replace(/^Merging #\d+ at \w+ /, "")
      case "merge-failed":
        return detail.replace(/^Merge of #\d+ at \w+ failed: /, "")
      case "paused":
        return detail.replace(/^Paused: /, "")
      case "rerun":
        return detail.replace(/^Rerunning /, "")
      case "wait":
        return detail.replace(/^Waiting /, "")
      default:
        return detail
    }
  })()
  return rest.trim() === "" ? null : rest
}

/** The log's detail column: a watch names its PR there, since its word does not. */
export function logDetail(entry: AutopilotHistoryEntry): string {
  if (entry.kind === "bound" && entry.pr !== null) return `#${entry.pr}`
  return historyDetail(entry) ?? ""
}

/** The commit, as the row shows it: seven characters, like `git log --oneline`. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** One row of a PR's section: an entry, or a run of routine waits folded into one line. */
export type HistoryItem =
  | { kind: "one"; entry: AutopilotHistoryEntry; round?: number }
  | { kind: "run"; entries: AutopilotHistoryEntry[] }

export interface HistoryGroup {
  /** null for the entries after the last PR: switched on, or waiting for the task's next PR */
  pr: number | null
  /** newest first */
  items: HistoryItem[]
  /** the group's merge, when its PR merged */
  merged: AutopilotHistoryEntry | null
  rounds: number
  events: number
}

/**
 * Group entries by the PR they belong to, newest group first, and fold each
 * run of consecutive waits into one item.
 *
 * An entry without a PR joins the PR in progress. Before a PR, or after one
 * merged, it joins the NEXT PR's group, so "Switched on" is the first line of
 * the first PR; what is left over forms the newest group, the next PR's.
 * Fix rounds are numbered within their PR, oldest first, as `wisp pr` counts
 * them.
 */
export function groupHistory(entries: readonly AutopilotHistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  const start = (pr: number | null): HistoryGroup => ({ pr, items: [], merged: null, rounds: 0, events: 0 })
  const add = (group: HistoryGroup, entry: AutopilotHistoryEntry) => {
    group.events++
    if (entry.kind === "merged") group.merged = entry
    const last = group.items.at(-1)
    if (entry.kind === "wait") {
      // oldest first while building; each run's entries are newest first
      if (last?.kind === "run") last.entries.unshift(entry)
      else group.items.push({ kind: "run", entries: [entry] })
    } else {
      group.items.push({ kind: "one", entry, round: entry.kind === "wake" ? ++group.rounds : undefined })
    }
  }
  let current: HistoryGroup | null = null
  let pending: AutopilotHistoryEntry[] = []
  for (const entry of [...entries].reverse()) {
    if (entry.pr === null) {
      if (current && !current.merged) add(current, entry)
      else pending.push(entry)
      continue
    }
    if (!current || current.pr !== entry.pr) {
      current = start(entry.pr)
      groups.push(current)
      for (const early of pending) add(current, early)
      pending = []
    }
    add(current, entry)
  }
  if (pending.length > 0) {
    const next = start(null)
    for (const late of pending) add(next, late)
    groups.push(next)
  }
  for (const group of groups) {
    group.items = group.items
      .map((item): HistoryItem => (item.kind === "run" && item.entries.length === 1 ? { kind: "one", entry: item.entries[0]! } : item))
      .reverse()
  }
  return groups.reverse()
}

/** The latest `count` meaningful entries, newest first, each with its fix round's number. */
export function recentHistory(entries: readonly AutopilotHistoryEntry[], count = 3): { entry: AutopilotHistoryEntry; round?: number }[] {
  const recent: { entry: AutopilotHistoryEntry; round?: number }[] = []
  for (const group of groupHistory(entries)) {
    for (const item of group.items) {
      if (item.kind !== "one" || !isMeaningful(item.entry)) continue
      recent.push({ entry: item.entry, round: item.round })
      if (recent.length === count) return recent
    }
  }
  return recent
}

/**
 * What a folded run waited for: each distinct reason once, newest first,
 * without the running count that changes on every look (`for checks`).
 */
export function runLabel(entries: readonly AutopilotHistoryEntry[]): string {
  // "for checks (2 running)" and "for checks to start" are both waits for checks
  const reasons = entries.map((entry) => (historyDetail(entry) ?? "").replace(/\s*\(\d+ running\)$/, "").replace(/ to start$/, ""))
  return [...new Set(reasons.filter((reason) => reason !== ""))].join(", ")
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * The repository a GitHub pull request URL belongs to, or null for anything
 * else: a SHA or a PR number only links where the host is known.
 */
export function repositoryUrl(pullRequestUrl: string | null | undefined): string | null {
  const match = pullRequestUrl?.match(/^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\/pull\/\d+\/?$/)
  return match ? match[1]! : null
}
