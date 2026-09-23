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

/** Autopilot is stuck on this PR and waiting for a person: needs you, or paused. */
export function autopilotBlocks(status: AutopilotStatus | null | undefined, number: number): boolean {
  return Boolean(status && (status.autoMerge || status.autoFix) && status.pr === number &&
    (status.state === "needs-you" || status.state === "paused"))
}
