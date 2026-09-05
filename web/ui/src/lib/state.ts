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
  if (task.state === "failed" && task.latest_turn_has_result && task.latest_turn_exit_code) {
    return `Exited ${task.latest_turn_exit_code}`
  }
  return STATE_LABEL[task.state]
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

/** "4 min ago" — relative, because nobody cares about the wall clock here. */
export function since(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(mins)) return ""
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
