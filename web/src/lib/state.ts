import type { ApiTask, TaskState, TurnStatus } from "./types"

/**
 * Task-state → tailwind class maps. These MUST stay static records: tailwind
 * only generates classes it can see literally in source, so `bg-state-${s}`
 * would silently produce nothing (the wisp-dev frontend reference).
 *
 * Design language: a state's hue lives ONLY on the 6px dot. `running` carries
 * the brand violet because it is the app being alive.
 */
export const STATE_DOT: Record<TaskState, string> = {
  creating: "bg-state-creating",
  running: "bg-state-running",
  done: "bg-state-done",
  "needs-input": "bg-state-needs-input",
  stuck: "bg-state-stuck",
  failed: "bg-state-failed",
}

/**
 * Sentence case for anything Wisp wrote. The API's own words stay lowercase
 * wherever they are shown as literal data (a payload, a log line, the palette).
 */
export const STATE_LABEL: Record<TaskState, string> = {
  creating: "Creating",
  running: "Running",
  done: "Done",
  "needs-input": "Needs input",
  stuck: "Stuck",
  failed: "Failed",
}

/**
 * The two states a person has to act on are the only ones allowed to tint
 * their own line of text. Every other state line is muted gray.
 */
export const STATE_TEXT: Record<TaskState, string> = {
  creating: "text-muted-foreground",
  running: "text-muted-foreground",
  done: "text-muted-foreground",
  "needs-input": "text-state-needs-input",
  stuck: "text-state-stuck",
  failed: "text-state-failed",
}

export const TURN_STATUS_TEXT: Record<TurnStatus, string> = {
  running: "text-muted-foreground",
  done: "text-muted-foreground",
  failed: "text-destructive",
  interrupted: "text-muted-foreground",
}

/**
 * The honest failure word (Theme B), mirroring `displayStateWord` in
 * src/types.ts: "Exited N" when the work landed — the latest turn HAS a
 * result — and the harness CLI then exited nonzero. "Failed" is reserved for
 * a turn that never delivered. Every other state keeps its own word, and the
 * hue stays the failure hue either way: the word is the fix, not the color.
 */
export function stateWord(task: ApiTask): string {
  const background = backgroundLabel(task.background);
  const outcome = task.state === "failed" && task.latest_turn_has_result && task.latest_turn_exit_code
    ? `Exited ${task.latest_turn_exit_code}` : STATE_LABEL[task.state]
  return background ? `${outcome} · ${background}` : outcome
}

export function backgroundLabel(background: ApiTask["background"]): string | null {
  if (background?.state === "running") return "Background work running";
  if (background?.state === "unknown") return "Background status unknown";
  if (background?.state === "stopping") return "Stopping background work";
  return null;
}

/**
 * The programs still running, deduped across groups — the short form, for
 * places that already have a sentence and only need the nouns.
 */
export function backgroundNames(background: ApiTask["background"], limit = 3): string | null {
  const names = [...new Set((background?.details ?? []).flatMap(group => group.names))]
  if (!names.length) return null
  return names.length > limit ? `${names.slice(0, limit).join(", ")}, +${names.length - limit}` : names.join(", ")
}

/**
 * What is actually still running, for the state dot's tooltip.
 *
 * The word alone ("Background work running") states a fact the reader can act
 * on in exactly one way — Stop — while withholding everything needed to decide
 * whether Stop is safe. One line per group: which turn started it, what the
 * programs are, and how far past the turn they have run.
 *
 * Empty when the daemon is older than background detail, so the caller falls
 * back to the word rather than rendering a confident blank.
 *
 * `now` is passed in rather than read here: this is a tooltip, so it is
 * correct as of its render, and a leaf dot in every sidebar row must not open
 * a clock subscription to say how old something is.
 */
export function backgroundDetail(background: ApiTask["background"], now: number): string | null {
  const details = background?.details
  if (!details?.length) return null
  return details
    .map(group => {
      const what = group.names.length ? group.names.join(", ") : `${group.processes} process${group.processes === 1 ? "" : "es"}`
      const age = group.since ? elapsed(group.since, now) : null
      return [`turn ${group.turn}: ${what}`, age && `${age} past the turn`, group.state === "unknown" && "ownership unverified"]
        .filter(Boolean)
        .join(" · ")
    })
    .join("\n")
}

/**
 * "41s" / "2m 41s" / "1h 02m" — the one shape every duration in the app takes.
 * Read at a glance, never to the millisecond, and never past two units: an
 * agent turn that has run for an hour does not need its seconds.
 */
export function formatDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`
}

/** How long a FINISHED turn took. Null while it is still running — see elapsed(). */
export function duration(startedAt: string | number, endedAt: string | number | null): string | null {
  if (endedAt === null) return null
  return formatDuration(new Date(endedAt).getTime() - new Date(startedAt).getTime())
}

/**
 * How long a turn has been running SO FAR. `now` is a parameter rather than a
 * Date.now() call so the value ticks from a caller that owns the interval —
 * one timer for the app, not one per rendered duration — and so this stays
 * testable without faking the clock.
 */
export function elapsed(startedAt: string, now: number): string | null {
  return formatDuration(now - new Date(startedAt).getTime())
}

/**
 * "4 min ago" — relative, because nobody cares about the wall clock here.
 * One relative clock for the app: the vocabulary and the arithmetic both live
 * in `lib/time.ts`, so a sidebar row and a prompt bubble never disagree.
 */
export { fromNow as since } from "./time"

export const CLEANUP_LABEL = {
  pending: "Cleanup pending", running: "Cleaning up", "needs-attention": "Cleanup needs attention", complete: "Cleanup complete",
} as const
