import { basename } from "node:path";

import { processStartTimeAsync } from "./procid";

export interface ProcessMember { pid: number; started: string | null }
export interface GroupMember extends ProcessMember {
  pgid: number;
  /** Current wall-clock interpretation of ps(1)'s lstart column. */
  observedStartedAt: number | null;
}

export function sameProcess(a: ProcessMember, b: ProcessMember): boolean {
  return a.pid === b.pid && a.started !== null && b.started !== null &&
    a.started.trim().replace(/\s+/g, " ") === b.started.trim().replace(/\s+/g, " ");
}

/**
 * No command lines or environment: only identity, group membership and
 * liveness. `processNames` below adds executable names on a separate,
 * failure-tolerant call, so this one keeps deciding ownership alone.
 */
export async function processSnapshot(groups: Set<number>): Promise<GroupMember[]> {
  if (groups.size === 0) return [];
  const child = Bun.spawn({ cmd: ["ps", "-axo", "pid=,pgid=,stat=,lstart="], stdout: "pipe", stderr: "ignore" });
  // ps is a single trusted system executable. Bound its own pipe and lifetime
  // without depending on Git's subprocess runner or a descendant's EOF.
  const reader = child.stdout.getReader();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; child.kill("SIGKILL"); void reader.cancel(); }, 2000);
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("process inventory exceeds its byte limit");
      chunks.push(value);
    }
    if (expired || await child.exited !== 0) throw new Error("process inventory unavailable");
    if (bytes === 0) throw new Error("empty process inventory");
    const members: GroupMember[] = [];
    for (const line of Buffer.concat(chunks).toString().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!line.trim()) continue;
      if (!match) throw new Error("unrecognized process inventory row");
      const pid = Number(match[1]); const pgid = Number(match[2]);
      // Zombies have exited and cannot write files, even before they are reaped.
      if (!groups.has(pgid) || match[3]!.startsWith("Z")) continue;
      const observedStartedAt = pid === pgid ? Date.parse(match[4]!) : Number.NaN;
      const started = process.platform === "linux" ? await processStartTimeAsync(pid) : match[4]!;
      members.push({ pid, pgid, started, observedStartedAt: Number.isNaN(observedStartedAt) ? null : observedStartedAt });
    }
    return members;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One naming call asks about at most this many pids, to bound `ps`'s argv. */
const NAME_LIMIT = 64;

/** `ps` reports an executable path; the operator wants the program. */
function programName(comm: string): string | null {
  const printable = [...basename(comm.trim())].filter(ch => {
    const code = ch.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7f;
  });
  return printable.join("").slice(0, 64) || null;
}

/**
 * Executable names for a bounded set of pids, so "Background work running"
 * can say WHAT is running instead of only that something is.
 *
 * Deliberately a second, best-effort `ps` rather than another column on the
 * inventory above. That call decides Stop's ownership: its row parser throws
 * on an unrecognized layout, and one throw strands every group at `unknown`.
 * Appending a field there would put naming — a convenience — on the path that
 * decides whether Wisp may signal a process. A failure here returns nothing
 * and changes no decision.
 *
 * Names only, never arguments: argv can carry tokens (see SECURITY.md).
 */
export async function processNames(pids: number[]): Promise<Map<number, string>> {
  const named = new Map<number, string>();
  const wanted = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0).slice(0, NAME_LIMIT);
  if (!wanted.length) return named;
  try {
    const child = Bun.spawn({ cmd: ["ps", "-o", "pid=,comm=", "-p", wanted.join(",")], stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const out = await new Response(child.stdout).text();
      await child.exited;
      for (const line of out.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        const name = match && programName(match[2]!);
        if (match && name) named.set(Number(match[1]), name);
      }
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } catch { /* Ownership and Stop never depend on a name. */ }
  return named;
}
