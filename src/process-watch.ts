import { closeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { processStartTimeAsync } from "./procid";

export type PidIdentity = "alive" | "dead" | "gone";

/**
 * Validate a persisted pid before believing or signaling it. A mismatched
 * start time means the pid was reused by a different process.
 */
export async function pidIdentity(pid: number, expectedStart: string | null): Promise<PidIdentity> {
  let exists: boolean;
  try {
    process.kill(pid, 0);
    exists = true;
  } catch (error) {
    exists = (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (!exists) return "dead";
  if (expectedStart === null) return "alive";
  const actual = await processStartTimeAsync(pid);
  if (actual === null) return "dead";
  return actual === expectedStart ? "alive" : "gone";
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
  paths: string[];
  maxBytes: number;
  killGraceMs: number;
  onEnded: () => Promise<void>;
  onKillReason: (reason: string) => void;
}

/**
 * Poll one daemon-orphaned process. The in-flight guard prevents a slow pid
 * or filesystem check from overlapping the next interval callback.
 */
export function startReAdoptionPoll(options: ReAdoptionPollOptions): void {
  let capTermAt: number | null = null;
  let polling = false;
  let settled = false;
  const tick = async (): Promise<void> => {
    if (polling || settled) return;
    polling = true;
    try {
      if ((await pidIdentity(options.pid, options.pidStartTime)) !== "alive") {
        settled = true;
        clearInterval(timer);
        await options.onEnded();
        return;
      }
      const hit = await fileOverCap(options.paths, options.maxBytes);
      if (!hit) return;
      const sig = capTermAt !== null && Date.now() - capTermAt >= options.killGraceMs ? "SIGKILL" : "SIGTERM";
      capTermAt ??= Date.now();
      options.onKillReason(
        sig === "SIGKILL"
          ? `log cap exceeded (${options.maxBytes} bytes); escalated to SIGKILL after SIGTERM was trapped`
          : `log cap exceeded (${options.maxBytes} bytes)`,
      );
      // stat() yielded after the first identity check. Revalidate immediately
      // before signaling so a process that exited meanwhile cannot hand its
      // recycled pid to an unrelated process.
      if ((await pidIdentity(options.pid, options.pidStartTime)) !== "alive") return;
      try {
        process.kill(options.pid, sig);
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
