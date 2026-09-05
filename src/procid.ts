/**
 * Process identity (a prior audit). A pid alone is not an identity — the OS
 * reuses pids, so a pid persisted before a daemon crash may point at an
 * unrelated process by the time we restart. The pair (pid, start time) is
 * unique for the machine's uptime: same pid + same start time = the same
 * process we spawned.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * A process's start time as an opaque identity token, or null when the pid
 * doesn't exist (or the platform gives no answer). Only equality matters —
 * the token is compared verbatim against what was persisted at spawn time.
 *
 * Linux: /proc/<pid>/stat field 22 (starttime, in clock ticks since boot) —
 * exact and cheap. Everywhere else (macOS included): `ps -o lstart=`, the
 * full unabbreviated start-time text, stable across ps invocations.
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
    const res = Bun.spawnSync({ cmd: ["ps", "-o", "lstart=", "-p", String(pid)] });
    if (res.exitCode !== 0) return null;
    return res.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Async twin for the daemon's poll and request paths (a prior audit): on macOS
 * every identity check is a `ps` spawn, and a spawnSync on the 3s re-adoption
 * tick (or an interrupt request) still stalls the daemon's only thread.
 */
export async function processStartTimeAsync(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return null;
    }
  }
  try {
    const proc = Bun.spawn({ cmd: ["ps", "-o", "lstart=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return out.trim() || null;
  } catch {
    return null;
  }
}

function parseProcStat(stat: string): string | null {
  // Field 2 (comm) may itself contain spaces and parens, so split the fields
  // AFTER the last ')': the token after it is field 3, making field 22 index 19.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ");
  const starttime = fields[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}
