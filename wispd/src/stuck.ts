import { backgroundPass } from "./home-lifetime";
import { stat } from "node:fs/promises";
import type { WispConfig } from "./config";
import { isUnresolvedInterrupt } from "./interrupt-state";
import { getTask, getTurn, runningTurns, transition } from "./store";

/**
 * One stuck-detection pass. Quiet running turns become stuck, while fresh
 * output restores a stuck task to running with one minute of hysteresis.
 *
 * Each decision is made from a read taken before the log `stat` yields, so it
 * commits only if nothing moved meanwhile: the turn is still running and the
 * task's seq is unchanged. Otherwise a turn that finalized during the await
 * would have `running` written over its finished task, with nothing left to
 * clear it. A Stop in progress or one that failed owns the task's state; its
 * detail is what tells the operator to retry, so no tick replaces it.
 */
export async function stuckTick(cfg: WispConfig, nowMs = Date.now()): Promise<void> {
  for (const turn of runningTurns()) {
    const task = getTask(turn.task_id);
    if (!task || task.archived || (task.state !== "running" && task.state !== "stuck")) continue;
    if (isUnresolvedInterrupt(task.state_detail)) continue;
    let mtime: number;
    try {
      mtime = (await stat(turn.log_file)).mtimeMs;
    } catch {
      continue;
    }
    if (getTurn(turn.id)?.status !== "running") continue;
    const quietMin = (nowMs - mtime) / 60000;
    if (task.state === "running" && quietMin >= cfg.stuckMinutes) {
      transition(task.id, "stuck", `no output for ${Math.round(quietMin)} min (turn ${turn.n})`, task.seq);
    } else if (task.state === "stuck" && quietMin < 1) {
      transition(task.id, "running", `turn ${turn.n} (recovered)`, task.seq);
    }
  }
}

export function startStuckLoop(cfg: WispConfig): ReturnType<typeof setInterval> {
  const timer = setInterval(() => void backgroundPass("stuck detection", () => stuckTick(cfg), { loop: true }), 60_000);
  timer.unref?.();
  return timer;
}
