import { ApiError } from "@/lib/transport"

/**
 * The daemon's refusal to restart over running turns: `409` with `running`,
 * the number of tasks the restart would interrupt. Null for any other failure.
 * The daemon owns the rule, so the browser and Desktop ask the same question
 * as `wisp update`.
 */
export function tasksInterruptedByUpdate(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const running = error.data.running
  return typeof running === "number" &&
    Number.isSafeInteger(running) &&
    running > 0
    ? running
    : null
}
