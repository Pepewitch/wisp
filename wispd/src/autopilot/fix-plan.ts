/**
 * What auto-fix says when a look has no round to send. Beside runtime.ts
 * because that file is at its size limit.
 */
import type { AutopilotState } from "../../../shared/autopilot"
import { MOVING_MS, WAITING_ON_YOU_MS } from "./cadence"
import type { FixPlan } from "./fix"
import { conversationsBlock } from "./gate"
import type { PrSnapshot } from "./github"
import { lastActivity } from "./look"
import type { AutopilotCheckpoint } from "./store"

/** Auto-fix alone counts as done once CI is green and the PR has been quiet this long. */
export const QUIET_MS = 15 * 60_000

/** No round to send: what CI alone says. */
export function nothingToSend(plan: FixPlan, checkpoint: AutopilotCheckpoint, say: (state: AutopilotState, reason: string, delayMs: number) => null): string | null {
  if (plan.kind === "none") return plan.reason
  if (plan.kind === "wait") return say("waiting", plan.reason, MOVING_MS)
  if (plan.kind === "needs-you") return say("needs-you", plan.reason, WAITING_ON_YOU_MS)
  if (plan.kind !== "fix") return null
  // The same evidence already reached a turn and the head did not move:
  // another round would only repeat itself.
  if (checkpoint.skipped?.includes(plan.key)) return say("needs-you", `${plan.reason} (auto-fix skipped)`, WAITING_ON_YOU_MS)
  return say("needs-you", `Still ${plan.summary} after round ${Math.max(checkpoint.rounds ?? 0, 1)}, with no new push`, WAITING_ON_YOU_MS)
}

/**
 * Auto-fix alone, with nothing for it to do. Open conversations need a
 * person only where the repository requires them resolved to merge. It is
 * done for now once CI is green and the PR has been quiet a while: no push,
 * round, review or comment since, and green for that long too.
 */
export function autoFixAlone(
  say: (state: AutopilotState, reason: string, delayMs: number, done?: boolean, patient?: boolean) => void,
  checkpoint: AutopilotCheckpoint, pr: PrSnapshot, nothingToFix: string, now: Date,
): void {
  if (conversationsBlock(pr)) {
    say("needs-you", `${pr.unresolvedThreads} unresolved conversation${pr.unresolvedThreads === 1 ? "" : "s"}`, WAITING_ON_YOU_MS)
    return
  }
  // only a green PR counts as done; a red that is main's own is still red
  const green = nothingToFix === "Nothing to fix"
  if (!green) { delete checkpoint.greenHead; delete checkpoint.greenAt }
  else if (checkpoint.greenHead !== pr.head) { checkpoint.greenHead = pr.head; checkpoint.greenAt = now.toISOString() }
  const quietFor = now.getTime() - lastActivity(pr, checkpoint)
  const done = green && quietFor >= QUIET_MS
  const reason = done ? `${nothingToFix} · no new review for ${QUIET_MS / 60_000} min` : nothingToFix
  // idle (done, or nothing it can fix) backs off; the quiet countdown looks exactly when it completes
  say("waiting", reason, done || !green ? WAITING_ON_YOU_MS : Math.min(WAITING_ON_YOU_MS, QUIET_MS - quietFor), done, done || !green)
}
