import type { AutopilotStatus } from "../../../shared/autopilot"

/** What auto-merge / auto-fix has to say about this PR, or null when it has nothing. */
export function autoMergeWords(status: AutopilotStatus | null | undefined, number: number): string | null {
  if (!status?.autoMerge && !status?.autoFix) return null
  const which = status.pr !== null && status.pr !== number ? ` #${status.pr}` : ""
  const name = status.by === "auto-fix" ? "Auto-fix" : "Auto-merge"
  // "Auto-fix will send: …" and "Auto-fix gave up…" already say who is speaking
  if (status.reason.startsWith(name) && !which) return status.reason
  return `${name}${which}${status.state === "paused" ? " paused" : ""}: ${status.reason}`
}

/**
 * What archiving would stop, when auto-merge or auto-fix is still watching a
 * PR: the daemon asks the same before an unforced archive.
 */
export function autopilotArchiveWords(status: AutopilotStatus | null | undefined): string | null {
  if (!status || !(status.autoMerge || status.autoFix) || status.pr === null || status.state === "merged" || status.state === "off") return null
  const both = status.autoMerge && status.autoFix
  const on = both ? "Auto-merge and auto-fix are" : status.autoMerge ? "Auto-merge is" : "Auto-fix is"
  return `${on} on for PR #${status.pr} — archiving switches ${both ? "them" : "it"} off.`
}

/** Which switches are on, for a label: "Auto-merge + auto-fix", "Auto-merge", "Auto-fix". */
export function autopilotSwitches(status: AutopilotStatus): string {
  return status.autoMerge && status.autoFix ? "Auto-merge + auto-fix" : status.autoMerge ? "Auto-merge" : "Auto-fix"
}

/**
 * The sidebar rail for a task with auto-merge or auto-fix on, or null when
 * both are off: red while it needs a person, violet once it is done for now
 * (the PR merged, or a quiet green PR under auto-fix), and the workflow blue
 * while it is on and working.
 */
export function autopilotRail(status: AutopilotStatus | null | undefined): "needs-you" | "done" | "on" | null {
  if (!status || !(status.autoMerge || status.autoFix) || status.state === "off" || status.state === "merged") return null
  if (status.state === "needs-you" || status.state === "paused") return "needs-you"
  return status.done ? "done" : "on"
}

/** Autopilot is stuck on this PR and waiting for a person: needs you, or paused. */
export function autopilotBlocks(status: AutopilotStatus | null | undefined, number: number): boolean {
  return Boolean(status && (status.autoMerge || status.autoFix) && status.pr === number &&
    (status.state === "needs-you" || status.state === "paused"))
}

/** The rail's three colours, as dot classes: the sidebar rail, and the Autopilot tab's live line. */
export const AUTOPILOT_RAIL_TONE = { "needs-you": "bg-destructive", done: "bg-primary", on: "bg-state-background" } as const

/** The rail's reading, plus "off" when neither switch is on: what the Autopilot tab tints its live line with. */
export function autopilotTint(status: AutopilotStatus | null | undefined): "needs-you" | "done" | "on" | "off" {
  if (!status || !(status.autoMerge || status.autoFix) || status.state === "off") return "off"
  // a finished row from before the switches stayed on across merges is done
  return autopilotRail(status) ?? "done"
}

/** The reason as the tab and its docked header say it: a pause names itself. */
export function autopilotReason(status: AutopilotStatus): string {
  return status.state === "paused" ? `Paused — ${status.reason}` : status.reason
}

/** Which switch's row the live line sits under: the one the reason speaks for, among those that are on. */
export function autopilotSpeaker(status: AutopilotStatus): "auto-merge" | "auto-fix" {
  if (status.by === "auto-fix" && status.autoFix) return "auto-fix"
  return status.autoMerge ? "auto-merge" : "auto-fix"
}

/**
 * The one action the state asks for: Resume a pause, Continue now after a
 * Stop hold, or Send now / Skip for an auto-fix round waiting out its delay.
 */
export function autopilotAction(status: AutopilotStatus | null | undefined): "resume" | "continue" | "round" | null {
  if (!status || !(status.autoMerge || status.autoFix)) return null
  if (status.state === "paused") return "resume"
  if (status.state === "held") return "continue"
  return status.autoFix && status.pendingFix ? "round" : null
}

/** What each switch does, said while it is off: the empty state is the onboarding. */
export const AUTOPILOT_OFF_WORDS = {
  "auto-merge": "Merges this task's PR once its checks pass and reviews allow it, then waits for the next PR.",
  "auto-fix": "When CI fails, the PR conflicts with its base, or a review asks for changes, sends the agent a fix round.",
} as const

/**
 * Why Wisp itself switched them off (the PR closed, the task was archived),
 * or null for a plain switch-off and a task never armed.
 */
export function autopilotOffReason(status: AutopilotStatus | null | undefined): string | null {
  if (!status || status.autoMerge || status.autoFix) return null
  return status.reason !== "" && status.reason !== "Auto-merge off" ? status.reason : null
}

/** Auto-fix's round count, as the quiet line under its switch says it while the other one speaks. */
export function fixRoundsWords(rounds: number): string {
  return rounds === 0 ? "no fix rounds yet" : rounds === 1 ? "1 fix round sent" : `${rounds} fix rounds sent`
}
