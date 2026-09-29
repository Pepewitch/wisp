import { trackHomeWork } from "./home-lifetime";
import { closeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { matchStartTime, readProcessStartTime } from "./procid";
import { signalProcessTree } from "./process-tree";

/**
 * - `alive`: our process, still running.
 * - `dead`: no process has this pid.
 * - `gone`: the pid belongs to a different process now (reused).
 * - `unknown`: a process has this pid, but whether it is ours could not be
 *   decided — `ps` failed to run, or an older Wisp stored a start time this
 *   daemon cannot read unambiguously. It proves neither liveness nor exit:
 *   never signal on it, and never finalize a turn on it.
 */
export type PidIdentity = "alive" | "dead" | "gone" | "unknown";

/**
 * Validate a persisted pid before believing or signaling it. A mismatched
 * start time means the pid was reused by a different process. `launchedAt`
 * (the turn's ISO start) lets an older Wisp's local-time token be compared
 * exactly; see `compareStartTimes`.
 */
export async function pidIdentity(pid: number, expectedStart: string | null, launchedAt?: string | null): Promise<PidIdentity> {
  let exists: boolean;
  try {
    process.kill(pid, 0);
    exists = true;
  } catch (error) {
    exists = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!exists) return "dead";
  if (expectedStart === null) return "alive";
  const actual = await readProcessStartTime(pid);
  if (actual.kind === "absent") return "dead";
  if (actual.kind === "unavailable") return "unknown";
  const match = await matchStartTime(pid, expectedStart, actual.token, launchedAt);
  return match === "same" ? "alive" : match === "different" ? "gone" : "unknown";
}

export async function fileOverCap(paths: string[], maxBytes: number): Promise<string | null> {
  for (const path of paths) {
    try {
      if ((await stat(path)).size > maxBytes) return path;
    } catch {
      /* file may not exist yet */
    }
  }
  return null;
}

export function closeDescriptors(fds: number[]): void {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

interface ReAdoptionPollOptions {
  pid: number;
  pidStartTime: string | null;
  /** When Wisp launched it (the turn's `started_at`). */
  launchedAt: string | null;
  paths: string[];
  /** null for a turn whose bounded recorder already owns primary storage. */
  maxBytes: number | null;
  killGraceMs: number;
  onEnded: () => Promise<void>;
  onKillReason: (reason: string) => void;
}

/**
 * Poll one daemon-orphaned process. The in-flight guard prevents a slow pid
 * or filesystem check from overlapping the next interval callback.
 */
export function startReAdoptionPoll(options: ReAdoptionPollOptions): void {
  let finish!: () => void;
  // Recoverable: an exiting daemon leaves the process for the next boot to re-adopt again.
  trackHomeWork(new Promise<void>(resolve => { finish = resolve; }), { recoverable: true });
  let capTermAt: number | null = null;
  let polling = false;
  let settled = false;
  const tick = async (): Promise<void> => {
    if (polling || settled) return;
    polling = true;
    try {
      const identity = await pidIdentity(options.pid, options.pidStartTime, options.launchedAt);
      // Unverified is not ended: keep waiting, and signal nothing, until an
      // answer says the process exited or is no longer ours.
      if (identity === "unknown") return;
      if (identity !== "alive") {
        settled = true;
        clearInterval(timer);
        try { await options.onEnded(); } finally { finish(); }
        return;
      }
      const hit = options.maxBytes === null ? null : await fileOverCap(options.paths, options.maxBytes);
      if (!hit) return;
      const sig = capTermAt !== null && Date.now() - capTermAt >= options.killGraceMs ? "SIGKILL" : "SIGTERM";
      capTermAt ??= Date.now();
      options.onKillReason(
        sig === "SIGKILL"
          ? `log cap exceeded (${options.maxBytes!} bytes); escalated to SIGKILL after SIGTERM was trapped`
          : `log cap exceeded (${options.maxBytes!} bytes)`,
      );
      // stat() yielded after the first identity check. Revalidate immediately
      // before signaling so a process that exited meanwhile cannot hand its
      // recycled pid to an unrelated process.
      if ((await pidIdentity(options.pid, options.pidStartTime, options.launchedAt)) !== "alive") return;
      try {
        // The whole group, so a cap kill does not leave the harness's own
        // children writing into the log it just exceeded (ENG-03).
        signalProcessTree(options.pid, sig, (signal) => process.kill(options.pid, signal));
      } catch {
        /* already gone; the next tick finalizes */
      }
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => {
    void tick().catch((error) => {
      console.error(`[wisp] re-adoption poll failed for pid ${options.pid}: ${String(error)}`);
    });
  }, 3000);
  timer.unref?.();
}
