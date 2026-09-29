import { rmSync } from "node:fs";
import { join } from "node:path";
import { WISP_HOME } from "./config";
import { readStateFile, writeStateFile } from "./state-file";
import { VERSION } from "./version";

/**
 * Whether the previous daemon ended cleanly.
 *
 * A service manager restarts a daemon that crashed, was killed for memory, or
 * died on a signal it did not handle, within seconds, and boot recovery then
 * re-adopts its running turns. From the outside that looks like nothing
 * happened, which is exactly what makes a crash loop invisible. So each run
 * leaves a marker in the home while it serves, and its graceful stop removes
 * it. A marker found at boot belongs to a run that never got to its stop: it
 * is logged, and kept in a short list that `wisp doctor` reads.
 */
export const DAEMON_RUN_PATH = join(WISP_HOME, "daemon-run.json");
export const DAEMON_EXITS_PATH = join(WISP_HOME, "daemon-exits.json");
/** How many unclean exits are remembered; the oldest is forgotten first. */
export const MAX_RECORDED_EXITS = 10;

export interface DaemonRun {
  pid: number;
  startedAt: string;
  version: string;
}

export interface UncleanExit extends DaemonRun {
  /** When the next boot found the run's marker still in place. */
  detectedAt: string;
}

export interface DaemonRunPaths {
  run: string;
  exits: string;
}

const DEFAULT_PATHS: DaemonRunPaths = { run: DAEMON_RUN_PATH, exits: DAEMON_EXITS_PATH };

function parseRun(value: unknown): DaemonRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.pid !== "number" || typeof run.startedAt !== "string") return null;
  return { pid: run.pid, startedAt: run.startedAt, version: typeof run.version === "string" ? run.version : "unknown" };
}

/** Recorded unclean exits, oldest first; empty when none were recorded or the file is unreadable. */
export function uncleanExits(path: string = DAEMON_EXITS_PATH): UncleanExit[] {
  const value = readStateFile(path) as { exits?: unknown } | null;
  if (!value || !Array.isArray(value.exits)) return [];
  return value.exits.flatMap((entry: unknown) => {
    const run = parseRun(entry);
    const detectedAt = (entry as { detectedAt?: unknown }).detectedAt;
    return run && typeof detectedAt === "string" ? [{ ...run, detectedAt }] : [];
  });
}

/** Unclean exits detected within `windowMs` of `now`. */
export function recentUncleanExits(exits: UncleanExit[], now: Date, windowMs: number): UncleanExit[] {
  return exits.filter((exit) => {
    const at = Date.parse(exit.detectedAt);
    return Number.isFinite(at) && now.getTime() - at <= windowMs;
  });
}

/**
 * When this run started and for how long it has served. `/api/health` carries
 * both: startedAt changes on every restart, so a poller can tell that one
 * happened even when it never saw the daemon go away.
 */
export function runTimes(run: DaemonRun, now: Date = new Date()): { startedAt: string; uptimeSeconds: number } {
  return { startedAt: run.startedAt, uptimeSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(run.startedAt)) / 1000)) };
}

let current: DaemonRun | null = null;

/** The run this process is serving, for the authenticated diagnostics. */
export function currentDaemonRun(): DaemonRun | null {
  return current;
}

/**
 * Called once the daemon owns its home, before boot recovery: a crash during
 * recovery is the kind of loop this exists to catch. Returns this run and,
 * when the previous one left its marker behind, that run.
 */
export function beginDaemonRun(
  now: Date = new Date(),
  paths: DaemonRunPaths = DEFAULT_PATHS,
  log: (line: string) => void = (line) => console.error(line),
): { run: DaemonRun; previous: DaemonRun | null } {
  const previous = parseRun(readStateFile(paths.run));
  if (previous) {
    const exits = [...uncleanExits(paths.exits), { ...previous, detectedAt: now.toISOString() }].slice(-MAX_RECORDED_EXITS);
    writeStateFile(paths.exits, { exits });
    const lastHour = recentUncleanExits(exits, now, 60 * 60_000).length;
    log(
      `[wisp] the previous daemon (pid ${previous.pid}, ${previous.version}, started ${previous.startedAt}) exited without shutting down` +
        ` (${lastHour} unclean exit${lastHour === 1 ? "" : "s"} in the last hour); its running turns are recovered now`,
    );
  }
  const run: DaemonRun = { pid: process.pid, startedAt: now.toISOString(), version: VERSION };
  writeStateFile(paths.run, run);
  current = run;
  return { run, previous };
}

/**
 * The graceful stop, and a boot that failed and says so itself. Removes the
 * marker only while it is still this run's, so a stop that finishes late can
 * never erase a successor's.
 */
export function endDaemonRun(run: DaemonRun, paths: DaemonRunPaths = DEFAULT_PATHS): void {
  if (current === run) current = null;
  const marker = parseRun(readStateFile(paths.run));
  if (!marker || marker.pid !== run.pid || marker.startedAt !== run.startedAt) return;
  try {
    rmSync(paths.run, { force: true });
  } catch {
    // the next boot reports an unclean exit: a false alarm, never a lost one
  }
}
