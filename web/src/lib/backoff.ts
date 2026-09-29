/** The longest a reconnecting stream waits between attempts. */
export const RECONNECT_CAP_MS = 30_000

/**
 * How long to wait before reconnect attempt `attempt` (0 is the first after a
 * drop): doubling from `baseMs` up to `capMs`, then scaled by a random factor
 * in [0.5, 1) so the clients a daemon restart dropped together do not all
 * return in the same second. The first attempt is never later than `baseMs`.
 */
export function reconnectDelay(
  attempt: number,
  baseMs: number,
  capMs = RECONNECT_CAP_MS,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 16))
  return Math.round(ceiling * (0.5 + random() / 2))
}
