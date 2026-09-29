import { errorDetail, safeString } from "./text";

/** How often a failure that keeps recurring is summarized, after its first full report. */
export const FAILURE_REPEAT_REPORT_MS = 10 * 60_000;
/** Distinct failures remembered at once; the oldest is forgotten first. */
const MAX_TRACKED_FAILURES = 256;

const recent = new Map<string, { repeats: number; since: number }>();

/**
 * Log a failure the daemon survives, without letting a recurring one flood
 * the log. The first occurrence of a label and message is logged in full,
 * with its stack. Repeats are counted, and at most once per
 * FAILURE_REPEAT_REPORT_MS a single "repeated N times" line says the failure
 * is still happening. A 10 s loop failing on every pass, or a browser pane
 * reconnecting to a failing stream every few seconds, would otherwise write
 * one stack per attempt.
 */
export function logFailure(label: string, error: unknown, now = Date.now()): void {
  const message = error instanceof Error ? error.message : safeString(error);
  const key = `${label}\u0000${message}`;
  const seen = recent.get(key);
  if (!seen) {
    if (recent.size >= MAX_TRACKED_FAILURES) recent.delete(recent.keys().next().value!);
    recent.set(key, { repeats: 0, since: now });
    console.error(`[wisp] ${label}: ${errorDetail(error)}`);
    return;
  }
  seen.repeats++;
  if (now - seen.since < FAILURE_REPEAT_REPORT_MS) return;
  const minutes = Math.round((now - seen.since) / 60_000);
  console.error(`[wisp] ${label}: repeated ${seen.repeats} more times in the last ${minutes} min: ${message}`);
  seen.repeats = 0;
  seen.since = now;
}
