import { closeLiveInput } from "./live-input";
import { INTERRUPTED, isUnresolvedInterrupt, STOP_FAILED, STOPPING } from "./interrupt-state";
import { pidIdentity } from "./process-watch";
import { forgetOwnedGroupIfEmpty, processGroupAlive, processGroupEnded, signalProcessGroup } from "./process-tree";
import { getTask, getTurn, latestTurnForTask, runningTurn, setTurnInterrupt, transition } from "./store";
import type { Turn } from "./types";

/** A stop's process phase must finish before either watcher can finalize. */
const interruptBarriers = new Map<number, Promise<void>>();
/** Concurrent explicit Stop requests share one operation. Sending never enters it. */
const interruptRequests = new Map<string, Promise<void>>();

export class InterruptConflict extends Error {}

function unresolvedInterrupt(taskId: string): Turn | null {
  const latest = latestTurnForTask(taskId);
  return isUnresolvedInterrupt(latest?.interrupt_detail) ? latest : null;
}

/** Persisted refusals also protect callers after a failed Stop or daemon restart. */
export function assertTaskNotStopping(taskId: string): void {
  const turn = unresolvedInterrupt(taskId);
  if (turn) throw new InterruptConflict(`${turn.interrupt_detail}; retry Stop before sending or archiving`);
  if (interruptBarriers.has(latestTurnForTask(taskId)?.id ?? -1)) throw new InterruptConflict(STOPPING);
}

/** Wait up to ms for the turn ROW to leave 'running' — i.e. finalize has run. */
export async function turnFinalized(turnId: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getTurn(turnId)?.status !== "running") return true;
    await Bun.sleep(100);
  }
  return getTurn(turnId)?.status !== "running";
}

/**
 * Explicit Stop only. A finalized leader is not proof that its group stopped.
 * Keep finalization behind the process phase; a queued or concurrent send must
 * never start work while a resistant descendant is still being terminated.
 */
export function interruptTaskTurn(
  taskId: string,
  graceMs: number,
  getLiveChild: (turnId: number) => ReturnType<typeof Bun.spawn> | undefined,
): Promise<void> {
  const existing = interruptRequests.get(taskId);
  if (existing) return existing;
  const turn = runningTurn(taskId) ?? unresolvedInterrupt(taskId);
  if (!turn) return Promise.reject(new Error("no running turn to interrupt"));
  const barrier = Promise.withResolvers<void>();
  interruptBarriers.set(turn.id, barrier.promise);
  // Defer until the barrier/request are registered, before the first yield.
  const request = Promise.resolve().then(async () => {
    try {
      await stopTurnProcesses(turn, graceMs, getLiveChild(turn.id));
    } finally {
      interruptBarriers.delete(turn.id);
      barrier.resolve();
    }
    if (await turnFinalized(turn.id, Math.max(graceMs, 4000))) {
      // A retry may be confirming a previously finalized, incomplete stop.
      if (isUnresolvedInterrupt(getTask(taskId)?.state_detail)) {
        transition(taskId, "needs-input", getTurn(turn.id)?.interrupt_detail ?? INTERRUPTED);
      }
      return;
    }
    const detail = `${STOP_FAILED}: turn ${turn.n} has not finished finalizing; retry Stop`;
    setTurnInterrupt(turn.id, detail);
    transition(taskId, "stuck", detail);
    throw new Error(detail);
  }).finally(() => {
    interruptRequests.delete(taskId);
  });
  interruptRequests.set(taskId, request);
  return request;
}

async function stopTurnProcesses(
  turn: Turn,
  graceMs: number,
  child: ReturnType<typeof Bun.spawn> | undefined,
): Promise<void> {
  if (!turn.pid) throw new Error("running turn has no pid to signal");
  const pid = turn.pid;
  const identity = await pidIdentity(pid, turn.pid_start_time);
  // No authority is recovered from an old numeric PID. A failed/interrupted
  // stop from another daemon can only confirm an empty group once its leader
  // is gone; unresolved survivors require operator cleanup, not blind signals.
  if (identity !== "alive" && !child) {
    if (identity === "dead" && unresolvedInterrupt(turn.task_id) && !processGroupAlive(pid)) {
      setTurnInterrupt(turn.id, INTERRUPTED);
      return;
    }
    if (identity === "dead" && processGroupAlive(pid)) {
      const detail = `${STOP_FAILED}: leader ${pid} is gone; stop its remaining processes and retry Stop`;
      setTurnInterrupt(turn.id, detail);
      transition(turn.task_id, "stuck", detail);
    }
    throw new Error(`turn process (pid ${pid}) is already gone or its identity changed; cannot safely stop its remaining processes`);
  }
  if (identity === "gone") throw new Error(`turn process (pid ${pid}) is already gone; its identity changed`);
  // Captured for this active interruption, while the leader is ours. A group
  // continues to exist after leader exit; escalation must keep targeting it.
  const grouped = processGroupAlive(pid);
  const signal = async (sig: "SIGTERM" | "SIGKILL"): Promise<void> => {
    const current = await pidIdentity(pid, turn.pid_start_time);
    if (current === "gone") throw new Error(`pid ${pid} changed identity; refusing to signal it`);
    if (grouped) signalProcessGroup(pid, sig);
    else if (current === "alive") {
      if (child) child.kill(sig);
      else process.kill(pid, sig);
    }
  };
  const ended = async (ms: number): Promise<boolean> => {
    if (grouped) return processGroupEnded(pid, ms);
    const deadline = Date.now() + ms;
    do {
      if ((await pidIdentity(pid, turn.pid_start_time)) !== "alive") return true;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    return (await pidIdentity(pid, turn.pid_start_time)) !== "alive";
  };
  setTurnInterrupt(turn.id, STOPPING);
  transition(turn.task_id, "running", STOPPING);
  try {
    // Removing live input happens synchronously. Do not let an RPC shutdown
    // wait delay TERM or its escalation; the process exit closes the transport.
    void closeLiveInput(turn.task_id, turn.id);
    await signal("SIGTERM");
    let detail = INTERRUPTED;
    if (!(await ended(graceMs))) {
      await signal("SIGKILL");
      detail = "turn interrupted (escalated to SIGKILL after SIGTERM was trapped) — session kept, send a correction";
      if (!(await ended(Math.max(graceMs, 1000)))) {
        throw new Error(`processes in turn ${turn.n} (pid ${pid}) survived SIGKILL`);
      }
    }
    forgetOwnedGroupIfEmpty(pid);
    setTurnInterrupt(turn.id, detail);
  } catch (error) {
    const detail = `${STOP_FAILED}: ${error instanceof Error ? error.message : String(error)}`;
    setTurnInterrupt(turn.id, detail);
    transition(turn.task_id, "stuck", detail);
    throw new Error(detail, { cause: error });
  }
}

/** Watchers wait only on process termination, never on their own finalization. */
export function waitForInterrupt(turnId: number): Promise<void> | undefined {
  return interruptBarriers.get(turnId);
}

export function isTaskStopping(taskId: string): boolean {
  return unresolvedInterrupt(taskId) !== null || interruptBarriers.has(latestTurnForTask(taskId)?.id ?? -1);
}
