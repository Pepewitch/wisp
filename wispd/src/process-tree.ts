/**
 * Stopping everything a turn started, not just the process Wisp launched.
 *
 * A harness is a supervisor. It runs builds, servers, test suites, and other
 * agents, and every one of those is a child of the process Wisp spawned. The
 * daemon used to signal only that leader, so a review reproduced the obvious
 * consequence: after `interruptTurn` the task had no running turn and the
 * harness's `sleep` was still alive. A Stop button that leaves commands,
 * servers, or billable work running is not a stop, and an immediate retry or
 * archive then overlaps whatever survived.
 *
 * The fix is the one the terminal already used for its shells: give the child
 * its own process GROUP (`detached: true` on the spawn) and signal the group
 * with a negative pid, which the kernel delivers to every member. This module
 * is the signalling half.
 *
 * What a process group can and cannot do, stated plainly because the
 * difference matters when someone reads a surviving process in `ps`:
 *
 *   * It reaches every descendant that stayed in the group — the normal case,
 *     including grandchildren, and including the ones holding a turn's stdout
 *     pipe open (which is what stalls finalization until they are gone).
 *   * It does NOT reach a descendant that deliberately left, by calling
 *     `setsid` or `setpgid` itself. A daemon a harness started on purpose
 *     (`npm run dev &` in a new session) is outside the group by design and
 *     stays running. Wisp does not chase it: the honest boundary is the group
 *     it owns, and pretending otherwise would mean killing by process-tree
 *     walk, which races pid reuse.
 */

/** What a group signal found. `gone` means no such group — nothing was signalled. */
export type TreeSignalOutcome = "group" | "process" | "gone";

/** ESRCH from a signal means "no such process or group", not a failure to handle. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Signal the process group led by `pid`. Returns `gone` when no group has that
 * id, which is the normal answer for a process that does not lead one — a turn
 * started by a daemon from before groups were owned, for instance.
 *
 * A group id IS the pid of its leader, so a negative signal can only reach a
 * group this pid created. Callers still validate the pid's identity first
 * (`pidIdentity`); this adds no new way to signal a stranger.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): TreeSignalOutcome {
  try {
    process.kill(-pid, signal);
    return "group";
  } catch {
    // Two reasons, one answer: ESRCH means the leader never made a group (or
    // the whole group is already gone), and EPERM means a group with that id
    // exists but is not ours to signal. Neither is a group this call stopped,
    // so the caller falls back to the leader it does own.
    return "gone";
  }
}

/**
 * Signal a turn's whole tree: the group first, then the leader alone if there
 * was no group. `signalLeader` is passed in rather than assumed, because the
 * live case signals through Bun's child handle (which also reaps) while a
 * re-adopted turn only has a pid.
 */
export function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  signalLeader: (signal: NodeJS.Signals) => void,
): TreeSignalOutcome {
  if (signalProcessGroup(pid, signal) === "group") return "group";
  try {
    signalLeader(signal);
    return "process";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "gone";
    throw error;
  }
}

/**
 * Whether any member of the group led by `pid` is still alive. Used to decide
 * whether a stop actually stopped something before anything destructive
 * follows it; a `gone` group is the only safe answer for archive.
 */
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means members exist that this process may not signal — still alive.
    return errorCode(error) === "EPERM";
  }
}

/** Wait up to `ms` for the group led by `pid` to empty out. */
export async function processGroupEnded(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !processGroupAlive(pid);
}
