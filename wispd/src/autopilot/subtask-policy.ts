/**
 * Autopilot on subtasks, and who may let one merge (spec decisions 9 and 13).
 *
 * - Only an `explore` subtask opens its own PR, so only it may have autopilot;
 *   `review` never pushes and `continue` opens no PR. Switching off is always
 *   allowed.
 * - Auto-merge is a person's to give. An agent (a request from a task's own
 *   turn) may pass it on only to its own explore children, and only while its
 *   own task holds merge rights from a person. The grant is recorded as
 *   `merge_granted_by` and checked again when Wisp is about to merge.
 *
 * Same-user threat model: this guards against mistakes and agents talking
 * each other into merging, not against the local user's own processes.
 */
import { db, getTask } from "../store"
import type { Task } from "../types"

export class MergeRightsError extends Error {}

const AGENT = /^agent:([a-z0-9]+)$/

/** Why this subtask may not have these switches on, or null. */
export function subtaskAutopilotRefusal(task: Task, on: boolean): string | null {
  if (!task.subtask_kind || !on || task.subtask_kind === "explore") return null
  return task.subtask_kind === "review"
    ? "A review subtask never pushes, so it has no PR for auto-merge, auto-fix or auto-review"
    : "A continue subtask opens no PR (its parent merges its branch), so it takes no auto-merge, auto-fix or auto-review"
}

/**
 * Whether a task holds merge rights from a person now: its own auto-merge a
 * person turned on, or a live workflow a person allowed to merge. Rows from
 * before this was recorded hold none.
 */
export function holdsMergeRights(taskId: string, now = new Date()): boolean {
  const task = getTask(taskId)
  if (!task || task.archived) return false
  const ownAutoMerge = task.merge_granted_by === "person" && db.query(`SELECT 1 FROM workflows WHERE task_id = ? AND type = 'pr-autopilot'
    AND state != 'completed' AND json_extract(params_json, '$.autoMerge') = 1`).get(taskId) !== null
  if (ownAutoMerge) return true
  return db.query(`SELECT 1 FROM workflows WHERE task_id = ? AND type != 'pr-autopilot' AND state = 'active'
    AND merge_allowed_by = 'person' AND expires_at > ? AND json_extract(params_json, '$.allowMerge') = 1`).get(taskId, now.toISOString()) !== null
}

/**
 * Who is granting auto-merge to this task, as `merge_granted_by` records it,
 * or a MergeRightsError naming why the grant is refused. Never dropped
 * silently: the caller refuses the whole request.
 */
export function mergeGrant(task: Task, actor: string): string {
  const agent = AGENT.exec(actor)?.[1]
  if (!agent) return "person"
  // a root task an agent arms keeps today's behaviour, recorded as the agent's: it confers no rights to pass on
  if (!task.subtask_kind) return actor
  if (task.parent_task_id !== agent || task.subtask_kind !== "explore") {
    throw new MergeRightsError(`merge rights: an agent may turn on auto-merge only for its own explore subtasks, and ${task.id} is not one of ${agent}'s`)
  }
  if (!holdsMergeRights(agent)) throw new MergeRightsError(`merge rights: task ${agent} has none from a person, so it cannot pass them on`)
  return `parent:${agent}`
}

/**
 * At merge time: a grant passed on by a parent stands only while that parent
 * still holds rights from a person. The reason names the parent, never more.
 */
export function inheritedRightsLost(task: Task): string | null {
  const from = /^parent:([a-z0-9]+)$/.exec(task.merge_granted_by ?? "")?.[1]
  if (!from || holdsMergeRights(from)) return null
  return `Merge rights came from task ${from}, which no longer has them — a person can turn auto-merge on again`
}
