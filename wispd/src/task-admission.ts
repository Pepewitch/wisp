import type { WispConfig } from "./config";
import { runningTurns } from "./store";

// Setup reservations bridge the async worktree/hook phase into the persisted turn.
// Startup resolves abandoned creation rows before accepting requests.
const preparing = new Set<string>();
export class TaskCapacityError extends Error {}
export function assertTaskCapacity(cfg: WispConfig, taskId?: string): void {
  const active = new Set([...preparing, ...runningTurns().map(turn => turn.task_id)]);
  if (taskId && active.has(taskId)) return; // steering and setup-to-turn handoff reuse their slot
  const limit = cfg.maxConcurrentTasks ?? 100;
  if (active.size >= limit) throw new TaskCapacityError(`All ${limit} concurrent task slots are occupied. Finish or stop another task, then retry. No limit applies to the number of turns in a task. You can change maxConcurrentTasks in config.json and restart Wisp.`);
}
export function reserveTaskCapacity(id: string, cfg: WispConfig): () => void {
  assertTaskCapacity(cfg, id);
  preparing.add(id);
  return () => { preparing.delete(id); };
}
