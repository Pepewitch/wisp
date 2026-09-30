/**
 * How soon autopilot looks at a PR again: soon while something moves on its
 * own, backing off while it only waits on a person or on nothing, and
 * stretched as Wisp's GitHub budget runs low (github-budget.ts).
 */

/** Something that moves on its own: checks running, a fresh head, a merge queue. */
export const MOVING_MS = 60_000
/** Blocked on a person, or no PR yet: where a patient wait backs off to. The settle event still brings it forward. */
export const WAITING_ON_YOU_MS = 5 * 60_000
/** A busy task: only a lifecycle look, for a PR someone else merged or closed. */
export const BUSY_MS = 20 * 60_000
/** However low the budget, a wait is never stretched past an hour. */
const STRETCHED_MAX_MS = 60 * 60_000

/** Consecutive patient looks that found the same situation. */
export interface Backoff { key: string; looks: number }

/**
 * The wait before the next look. A patient one (a person must act, or nothing
 * is happening) starts at MOVING_MS and doubles with every look that finds the
 * same situation, up to its own delay. Any other look (checks running, Wisp's
 * own rerun or round, the agent's push) or a new situation starts it over.
 */
export function nextDelay(input: { delayMs: number; patient: boolean; key: string; previous?: Backoff; stretch: number }): { delayMs: number; backoff?: Backoff } {
  let delayMs = input.delayMs
  let backoff: Backoff | undefined
  if (input.patient) {
    const looks = input.previous?.key === input.key ? input.previous.looks + 1 : 0
    backoff = { key: input.key, looks }
    delayMs = Math.min(input.delayMs, MOVING_MS * 2 ** Math.min(looks, 10))
  }
  if (input.stretch > 1) delayMs = Math.max(delayMs, Math.min(delayMs * input.stretch, STRETCHED_MAX_MS))
  return backoff ? { delayMs, backoff } : { delayMs }
}
