/**
 * The backstop for subtask queues. A queued start refused by a parent's
 * running cap waits (runner.ts), and every path that frees a slot drains its
 * siblings; this pass covers what those paths cannot see, such as a sibling
 * whose turn ended in a daemon that has since restarted.
 */
import type { AdapterDef } from "./adapters";
import type { WispConfig } from "./config";
import { drainSubtaskQueues } from "./runner";
import { parentsWithWaitingChildren } from "./subtasks";

export const SUBTASK_QUEUE_INTERVAL_MS = 30_000;

export function drainWaitingSubtasks(adapters: Readonly<Record<string, AdapterDef>>, cfg: WispConfig): void {
  for (const parent of parentsWithWaitingChildren()) drainSubtaskQueues(parent, adapters, cfg);
}

export function startSubtaskQueueLoop(adapters: Readonly<Record<string, AdapterDef>>, cfg: WispConfig): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      drainWaitingSubtasks(adapters, cfg);
    } catch (error) {
      console.error(`[wisp] subtask queues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, SUBTASK_QUEUE_INTERVAL_MS);
}
