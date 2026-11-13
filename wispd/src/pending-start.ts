import { getTask, reconcileTaskState, runningTurn, transition } from "./store";
import { adoptable, endLingeringProcess, sameAgent, turnProcesses } from "./turn-process";
import type { Task, TaskMessage, TaskState } from "./types";

/**
 * Tasks whose next turn waits for an earlier harness process to exit (a
 * message for another model, effort or context, or one that came as a warm
 * process was closing): what each read before, and the seq the wait wrote.
 */
const pendingStarts = new Map<string, { state: TaskState; detail: string | null; seq: number }>();

/**
 * A queued message starts its turn once the task's earlier `harness` process
 * exits (its exit watcher starts the queue), which takes about half a second
 * for claude and up to KILL_GRACE_MS for background work. Until then the task
 * reads `running`: read as settled, its last answer would pass for the reply
 * to this message with `wisp wait`, and a heartbeat, a subtask report or
 * autopilot would take the task as idle. Memory only: boot settles a
 * `running` task with no turn (settleStrandedTasks).
 */
function awaitProcessExit(task: Task, turn: number, harness: string): void {
  if (pendingStarts.has(task.id) || task.state === "running") return;
  if (!transition(task.id, "running", `turn ${turn} starts once the earlier ${harness} process exits`)) return;
  pendingStarts.set(task.id, { state: task.state, detail: task.state_detail, seq: getTask(task.id)!.seq });
}

/**
 * Whether the task's lingering process keeps `message` from starting now.
 * Still settling its last answer, or exited and not yet let go by its
 * watcher: either one starts the queue itself when it is done. Settling takes
 * a moment and settles the task itself; an exit can take seconds, and so can
 * ending one that cannot take a turn for another agent.
 */
export function lingeringHoldsStart(task: Task, message: TaskMessage, turn: number): boolean {
  const lingering = turnProcesses.get(task.id);
  if (!lingering) return false;
  if (!adoptable(lingering)) {
    if (lingering.live?.phase !== "settling") awaitProcessExit(task, turn, lingering.agent.harness);
    return true;
  }
  const agent = { context_n: message.context_n, harness: message.harness, model: message.model, effort: message.effort, fast: message.fast === 1 };
  if (sameAgent(lingering.agent, agent)) return false;
  endLingeringProcess(lingering, `turn ${turn} asks for another agent`);
  awaitProcessExit(task, turn, lingering.agent.harness);
  return true;
}

/**
 * The queue had its turn after the process exited: a turn started, or nothing
 * did (the message was withdrawn, a slot or a merge holds it), and the task
 * reads what it read before. A state set meanwhile (a failed start) stands.
 */
export function settlePendingStart(taskId: string): void {
  const waited = pendingStarts.get(taskId);
  if (!waited) return;
  pendingStarts.delete(taskId);
  const task = getTask(taskId);
  if (!task || task.state !== "running" || runningTurn(taskId)) return;
  // a detail written meanwhile (waiting for a slot) is kept
  reconcileTaskState(taskId, waited.state, task.seq === waited.seq ? waited.detail : task.state_detail);
}
