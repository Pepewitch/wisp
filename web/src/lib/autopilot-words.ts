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
