import { stat } from "node:fs/promises";
import type { WispConfig } from "./config";
import { getTask, runningTurns, transition } from "./store";

/**
 * One stuck-detection pass. Quiet running turns become stuck, while fresh
 * output restores a stuck task to running with one minute of hysteresis.
 */
export async function stuckTick(cfg: WispConfig, nowMs = Date.now()): Promise<void> {
  for (const turn of runningTurns()) {
    const task = getTask(turn.task_id);
    if (!task || task.archived || (task.state !== "running" && task.state !== "stuck")) continue;
    let mtime: number;
    try {
      mtime = (await stat(turn.log_file)).mtimeMs;
    } catch {
      continue;
    }
    const quietMin = (nowMs - mtime) / 60000;
    if (task.state === "running" && quietMin >= cfg.stuckMinutes) {
      transition(task.id, "stuck", `no output for ${Math.round(quietMin)} min (turn ${turn.n})`);
    } else if (task.state === "stuck" && quietMin < 1) {
      transition(task.id, "running", `turn ${turn.n} (recovered)`);
    }
  }
}

export function startStuckLoop(cfg: WispConfig): void {
  setInterval(() => void stuckTick(cfg), 60_000);
}
