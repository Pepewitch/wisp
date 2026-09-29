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
 * one stack per attempt. `context` says which instance this one was (a
 * task, an event) without being part of what counts as a repeat; a summary
 * names the latest.
 */
export function logFailure(label: string, error: unknown, now = Date.now(), context?: string): void {
  const message = error instanceof Error ? error.message : safeString(error);
  const key = `${label}\u0000${message}`;
  const seen = recent.get(key);
  const about = context ? ` (${context})` : "";
  if (!seen) {
    if (recent.size >= MAX_TRACKED_FAILURES) recent.delete(recent.keys().next().value!);
    recent.set(key, { repeats: 0, since: now });
    console.error(`[wisp] ${label}${about}: ${errorDetail(error)}`);
    return;
  }
  seen.repeats++;
  if (now - seen.since < FAILURE_REPEAT_REPORT_MS) return;
  const minutes = Math.round((now - seen.since) / 60_000);
  const latest = context ? ` (latest: ${context})` : "";
  console.error(`[wisp] ${label}: repeated ${seen.repeats} more times in the last ${minutes} min${latest}: ${message}`);
  seen.repeats = 0;
  seen.since = now;
}

type LogMethod = "log" | "info" | "warn" | "error";
const LOG_METHODS: LogMethod[] = ["log", "info", "warn", "error"];
const stamped = new WeakSet<object>();

/**
 * Prefix every line the daemon writes to its own log with an ISO-8601 UTC
 * timestamp. The service manager adds none (launchd writes the stream to a
 * file verbatim), so without this a crash in the log could not be matched to
 * the time anything else happened. Installed once, by `wisp serve` only, at
 * the lowest seam every log line shares, rather than by rewriting each of the
 * daemon's many `console.*` calls; the `[wisp]` tag and the destination stay
 * as they were. The first argument is prefixed in place when it is a string,
 * so a format string still formats.
 */
export function installLogTimestamps(target: Pick<Console, LogMethod> = console, clock: () => Date = () => new Date()): void {
  if (stamped.has(target)) return;
  stamped.add(target);
  for (const method of LOG_METHODS) {
    const write = target[method].bind(target);
    target[method] = (...args: unknown[]): void => {
      const at = clock().toISOString();
      if (typeof args[0] === "string") write(`${at} ${args[0]}`, ...args.slice(1));
      else write(at, ...args);
    };
  }
}
