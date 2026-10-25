/**
 * What auto-fix says when a look has no round to send. Beside runtime.ts
 * because that file is at its size limit.
 */
import type { AutopilotState } from "../../../shared/autopilot"
import { MOVING_MS, WAITING_ON_YOU_MS } from "./cadence"
import type { FixPlan } from "./fix"
import type { AutopilotCheckpoint } from "./store"

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
