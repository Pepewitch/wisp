import type { WispConfig } from "./config";
import { runningSubtaskCap } from "./config-subtasks";
import { getTask, runningTurns } from "./store";
import { cappedParent, liveNonReviewerChildren } from "./subtasks";

// Setup reservations bridge the async worktree/hook phase into the persisted turn.
// Startup resolves abandoned creation rows before accepting requests.
const preparing = new Set<string>();
export class TaskCapacityError extends Error {}
/** A parent's running-subtask cap, not the global limit: a queued start waits for it instead of failing. */
export class SubtaskCapError extends TaskCapacityError {
  constructor(readonly parentId: string, message: string) {
    super(message);
  }
}

/**
 * What a slot is for. Only a `turn` (a task's own work) is held to its
 * parent's running-subtask cap; a reviewer or a recipe task Wisp starts is
 * held to the global limit alone, so a busy family never stalls its review.
 */
export type Workload = "turn" | "reviewer" | "recipe";

export interface CapacityScope {
  /** The parent of a task that does not exist yet (creation); otherwise read from the task's row. */
  parentId?: string | null;
  workload?: Workload;
}

export function assertTaskCapacity(cfg: WispConfig, taskId?: string, scope: CapacityScope = {}): void {
  const active = new Set([...preparing, ...runningTurns().map(turn => turn.task_id)]);
  if (taskId && active.has(taskId)) return; // steering and setup-to-turn handoff reuse their slot
  const limit = cfg.maxConcurrentTasks ?? 100;
  if (active.size >= limit) throw new TaskCapacityError(`All ${limit} concurrent task slots are occupied. Finish or stop another task, then retry. No limit applies to the number of turns in a task. You can change maxConcurrentTasks in config.json and restart Wisp.`);
  if ((scope.workload ?? "turn") !== "turn") return;
  const parentId = scope.parentId !== undefined ? scope.parentId : cappedParent(taskId ? getTask(taskId) : null);
  if (!parentId) return;
  const cap = runningSubtaskCap(cfg);
  const running = liveNonReviewerChildren(parentId).filter((child) => active.has(child.id)).length;
  if (running >= cap) {
    throw new SubtaskCapError(parentId, `Task ${parentId} already has ${running} subtasks starting or running, its limit. This one waits for one of them to finish. You can change maxRunningSubtasks in config.json.`);
  }
}
/** Whether a turn for this task would get a slot now: assertTaskCapacity's answer, without the throw. */
export function hasTaskCapacity(cfg: WispConfig, taskId?: string, scope: CapacityScope = {}): boolean {
  try {
    assertTaskCapacity(cfg, taskId, scope);
    return true;
  } catch (error) {
    if (error instanceof TaskCapacityError) return false;
    throw error;
  }
}
export function reserveTaskCapacity(id: string, cfg: WispConfig, scope: CapacityScope = {}): () => void {
  assertTaskCapacity(cfg, id, scope);
  preparing.add(id);
  return () => { preparing.delete(id); };
}
