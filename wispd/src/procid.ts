/**
 * Process identity (a prior audit). A pid alone is not an identity — the OS
 * reuses pids, so a pid persisted before a daemon crash may point at an
 * unrelated process by the time we restart. The pair (pid, start time) is
 * unique for the machine's uptime: same pid + same start time = the same
 * process we spawned.
 *
 * The start time must mean the same thing to every daemon that reads it. On
 * macOS it comes from `ps -o lstart=`, which prints local time in the current
 * locale: the same process reads `Tue Sep 29 10:25:37 2026` in one timezone,
 * `Tue Sep 29 03:25:37 2026` under `TZ=UTC` and `mar. 29 sept. 10:25:37 2026`
 * in French. A daemon restarted under another `TZ` or `LANG` (a terminal
 * `wisp serve` versus the login service, or a laptop that changed timezone)
 * used to call its own live harness a reused pid, fail the turn, and let the
 * next send start a second harness in the same worktree. So `ps` always runs
 * with `TZ=UTC0 LC_ALL=C`, and the token is the instant it names.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * What asking for a process's start time found. `absent` is a positive answer
 * (no such process); `unavailable` means the question could not be asked — a
 * `ps` that failed to spawn under fd or process exhaustion, or an answer in a
 * shape we do not read — and says nothing about whether the process exists.
 */
export type StartTimeRead =
  | { kind: "found"; token: string }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** How two start-time tokens relate. `uncertain` is neither proof of identity nor of reuse. */
export type StartMatch = "same" | "different" | "uncertain";

const ABSENT: StartTimeRead = { kind: "absent" };
const UNAVAILABLE: StartTimeRead = { kind: "unavailable" };

/**
 * Environment for every `ps` whose time column Wisp reads: UTC in the C
 * locale, so the text never depends on the daemon's own zone or language.
 * `UTC0` is a POSIX TZ string, so it needs no zoneinfo database.
 */
export function psTimeEnv(): Record<string, string | undefined> {
  return { ...process.env, TZ: "UTC0", LC_ALL: "C" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/**
 * The wall-clock fields of a C-locale `lstart` (`Tue Sep  9 03:25:37 2026`)
 * as if they were UTC, in epoch ms; null for anything else. Whether they
 * really ARE UTC depends on the zone `ps` ran in, which only the caller knows.
 */
export function lstartWallClock(text: string): number | null {
  const match = text.trim().match(LSTART);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!);
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(Number) as [number, number, number, number, number];
  if (month < 0 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // Date.UTC rolls "Feb 31" into March; a real ps never prints one.
  return new Date(ms).getUTCDate() === day ? ms : null;
}

/** The canonical token for a start instant: whole-second ISO-8601 UTC. */
export function startToken(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Linux: /proc/<pid>/stat starttime, clock ticks since boot. */
const TICKS = /^\d+$/;
const QUARTER_HOUR_MS = 15 * 60_000;
/** Every real UTC offset is a whole quarter hour between these. */
const MIN_OFFSET_MS = -12 * 3_600_000;
const MAX_OFFSET_MS = 14 * 3_600_000;
/** A turn row is written in the same synchronous block as its spawn. */
const LAUNCH_SLOP_MS = 2 * 60_000;

function plausibleOffset(offsetMs: number): boolean {
  return offsetMs % QUARTER_HOUR_MS === 0 && offsetMs >= MIN_OFFSET_MS && offsetMs <= MAX_OFFSET_MS;
}

/** `instant` rendered as a wall clock in this daemon's zone, as the fields of a UTC epoch. */
function localWallClock(instant: number): number {
  const d = new Date(instant);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

/**
 * A token stored before start times were canonical: the `lstart` text of a
 * daemon whose zone (and locale) we were never told. Two facts make it
 * comparable anyway: every zone renders an instant as that instant plus a
 * whole quarter hour, and when Wisp knows roughly when it launched the process
 * (a turn row is written beside its spawn), that launch time pins which
 * quarter hour the recording daemon used.
 */
function compareLegacy(recorded: string, instant: number, launchedAt: string | null | undefined): StartMatch {
  const launched = launchedAt ? Date.parse(launchedAt) : Number.NaN;
  // Whatever the token says, a process that started well away from when Wisp
  // launched this one is not it. This alone settles a pid reused by a stranger
  // even when the token is in a locale nothing here can read.
  if (Number.isFinite(launched) && Math.abs(instant - launched) > LAUNCH_SLOP_MS) return "different";
  const wall = lstartWallClock(recorded);
  // Another locale's text: it can neither confirm nor rule out a process that
  // started when this one was launched.
  if (wall === null) return "uncertain";
  if (Number.isFinite(launched)) {
    const offset = Math.round((wall - launched) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
    // The recording zone is now known exactly, so the answer is as strong as
    // a canonical comparison.
    if (plausibleOffset(offset) && Math.abs(wall - launched - offset) <= LAUNCH_SLOP_MS) {
      return wall - offset === instant ? "same" : "different";
    }
  }
  // What the old verbatim comparison accepted: rendered in this daemon's zone.
  if (localWallClock(instant) === wall) return "same";
  // Some zone renders this instant as that text: our process under another
  // TZ, or a stranger whose start is a whole quarter hour away. No zone
  // renders it at all: a different process.
  return plausibleOffset(wall - instant) ? "uncertain" : "different";
}

/**
 * Compare a persisted start-time token with the one a process has now.
 * `launchedAt` is the ISO time Wisp launched the recorded process, when known;
 * it only matters for a token stored by an older Wisp.
 */
export function compareStartTimes(recorded: string, current: string, launchedAt?: string | null): StartMatch {
  const r = recorded.trim().replace(/\s+/g, " ");
  const c = current.trim().replace(/\s+/g, " ");
  if (r === c) return "same";
  if (TICKS.test(r) || CANONICAL.test(r) || !CANONICAL.test(c)) return "different";
  return compareLegacy(r, Date.parse(c), launchedAt);
}

/** A process's canonical start token from the `lstart=` text a `psTimeEnv()` ps printed. */
function tokenFromLstart(text: string): string | null {
  const at = lstartWallClock(text);
  return at === null ? null : startToken(at);
}

/**
 * A process's start time as an identity token, or null when the pid doesn't
 * exist (or the platform gives no answer). Compare tokens with
 * `compareStartTimes`, never verbatim.
 *
 * Linux: /proc/<pid>/stat field 22 (starttime, in clock ticks since boot) —
 * exact and cheap. Everywhere else (macOS included): `ps -o lstart=` in
 * `psTimeEnv()`, as a whole-second UTC ISO instant.
 *
 * SYNC ON PURPOSE: used only at spawn time (startTurn captures the identity
 * before the turn row exists, and that capture must not yield the event loop
 * between spawn and createTurn). One tiny ps/proc read per turn spawn is the
 * same startup-cheap class as the fd-direct log opens (a prior audit). Every
 * later validation — poll loops, interrupt/archive signaling — uses the
 * async variant below.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }
  try {
    const res = Bun.spawnSync({ cmd: ["ps", "-o", "lstart=", "-p", String(pid)], env: psTimeEnv(), stderr: "ignore" });
    if (res.exitCode !== 0) return null;
    return tokenFromLstart(res.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Async twin for the daemon's poll and request paths (a prior audit): on macOS
 * every identity check is a `ps` spawn, and a spawnSync on the 3s re-adoption
 * tick (or an interrupt request) still stalls the daemon's only thread.
 *
 * Unlike the spawn-time read it keeps "no such process" apart from "could not
 * ask": a caller that has just seen the pid exist must not hear "dead" because
 * `ps` hit EAGAIN or EMFILE.
 */
export async function readProcessStartTime(pid: number): Promise<StartTimeRead> {
  if (!Number.isInteger(pid) || pid <= 0) return ABSENT;
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ESRCH" ? ABSENT : UNAVAILABLE;
    }
    const token = parseProcStat(stat);
    return token ? { kind: "found", token } : UNAVAILABLE;
  }
  try {
    const proc = Bun.spawn({ cmd: ["ps", "-o", "lstart=", "-p", String(pid)], env: psTimeEnv(), stdout: "pipe", stderr: "ignore" });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const text = out.trim();
    // ps -p exits 1 with no rows when no such process exists.
    if (exitCode === 1 && text === "") return ABSENT;
    const token = exitCode === 0 ? tokenFromLstart(text) : null;
    return token ? { kind: "found", token } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

function parseProcStat(stat: string): string | null {
  // Field 2 (comm) may itself contain spaces and parens, so split the fields
  // AFTER the last ')': the token after it is field 3, making field 22 index 19.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}
