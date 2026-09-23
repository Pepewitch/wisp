import type { Workflow, WorkflowDecision, WorkflowDefinition, WorkflowHistory, WorkflowParams, WorkflowState } from "../../../shared/workflows";
import { db } from "../store-database";
import { emit } from "../events";
import { createTaskMessage, getTask, getTaskMessage, randomId } from "../store";
import { AUTOPILOT_TYPE, CONTEXT_CHANGE_PAUSE } from "../autopilot/type";

export interface WorkflowRow {
  id: string; task_id: string; type: string; version: string; params_json: string;
  checkpoint_json: string; state: WorkflowState; reason: string; revision: number;
  context_n: number; wake_count: number; check_count: number; failures: number;
  last_checked_at: string | null; next_check_at: string; expires_at: string;
  created_at: string; updated_at: string;
}
export function workflow(row: WorkflowRow): Workflow {
  return {
    id: row.id, taskId: row.task_id, type: row.type, version: row.version,
    params: JSON.parse(row.params_json), state: row.state, reason: row.reason,
    revision: row.revision, contextN: row.context_n, wakeCount: row.wake_count,
    checkCount: row.check_count, lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export function getWorkflow(id: string): WorkflowRow | null {
  return db.query("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowRow | null;
}
export function listWorkflows(taskId: string): Workflow[] {
  return (db.query("SELECT * FROM workflows WHERE task_id = ? ORDER BY created_at DESC, id").all(taskId) as WorkflowRow[]).map(workflow);
}
/**
 * Task ids with standing workflow state; completed history is no longer
 * attached. Autopilot is not counted: it lives for a whole PR, and the ring it
 * would draw replaces the needs-input and failed fills a person must see.
 */
export function taskIdsWithAttachedWorkflows(): Set<string> {
  const rows = db.query("SELECT DISTINCT task_id FROM workflows WHERE state != 'completed' AND type != ?").all(AUTOPILOT_TYPE) as { task_id: string }[];
  return new Set(rows.map(row => row.task_id));
}
export function workflowHistory(id: string): WorkflowHistory[] {
  return db.query("SELECT id, at, kind, detail, message_id AS messageId FROM workflow_history WHERE workflow_id = ? ORDER BY id DESC LIMIT 100").all(id) as WorkflowHistory[];
}
export function recordWorkflow(id: string, kind: string, detail: string, at: string, messageId: string | null = null): void {
  db.run("INSERT INTO workflow_history(workflow_id, at, kind, detail, message_id) VALUES (?, ?, ?, ?, ?)", [id, at, kind, detail.slice(0, 1000), messageId]);
  db.run("DELETE FROM workflow_history WHERE workflow_id = ? AND id NOT IN (SELECT id FROM workflow_history WHERE workflow_id = ? ORDER BY id DESC LIMIT 100)", [id, id]);
}
export function announceWorkflow(taskId: string): void { emit({ type: "workflow", taskId }); }

export function createWorkflow(taskId: string, def: WorkflowDefinition, params: WorkflowParams, now = new Date()): Workflow {
  const result = db.transaction(() => {
    const task = getTask(taskId);
    if (!task || task.archived || !task.worktree_path) throw new Error("A workflow needs a live task with a usable checkout");
    if (listWorkflows(taskId).filter(w => w.state !== "completed").length >= 10) throw new Error("A task can have at most 10 unfinished workflows");
    const id = randomId("w", 12), at = now.toISOString();
    const scheduled = def.id === "schedule-steer" ? Date.parse(String(params.scheduledAt)) : null;
    if (scheduled !== null && scheduled <= now.getTime()) throw new Error("Scheduled time must be in the future");
    const next = scheduled === null
      ? new Date(now.getTime() + (def.id === "heartbeat" ? Number(params.everyMinutes) * 60_000 : 0)).toISOString()
      : new Date(scheduled).toISOString();
    // A scheduled steer is allowed to arrive late after the host was asleep.
    // Its chosen instant is the due date, not a narrow delivery window.
    const expires = scheduled === null
      ? new Date(now.getTime() + Number(params.lifetimeHours) * 3_600_000).toISOString()
      : "9999-12-31T23:59:59.999Z";
    const reason = scheduled === null ? "Waiting for first check" : `Scheduled for ${new Date(scheduled).toISOString()}`;
    db.run(`INSERT INTO workflows(id, task_id, type, version, params_json, state, reason, context_n, next_check_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [id, taskId, def.id, def.version, JSON.stringify(params), reason, task.context_n, next, expires, at, at]);
    recordWorkflow(id, "armed", def.name, at);
    return workflow(getWorkflow(id)!);
  })();
  announceWorkflow(taskId);
  return result;
}
export function cancelWorkflowMessages(id: string): void {
  // The cancellation trigger restores acknowledgements for definitely
  // undelivered intents, including cancellation during context changes.
  db.run("UPDATE task_messages SET status = 'cancelled' WHERE workflow_id = ? AND status = 'queued' AND claim IS NULL", [id]);
}
export function changeWorkflowState(id: string, state: WorkflowState, reason: string, now = new Date()): Workflow {
  const result = db.transaction(() => {
    const row = getWorkflow(id);
    if (!row) throw new Error("Workflow not found");
    if (row.state === "completed") {
      if (state === "completed") return workflow(row);
      throw new Error("Completed workflows cannot resume; arm a new instance");
    }
    const task = getTask(row.task_id);
    const item = workflow(row);
    if (state === "active" && (!task || task.archived || Date.parse(row.expires_at) <= now.getTime() ||
      (row.type !== "schedule-steer" && row.type !== AUTOPILOT_TYPE && row.wake_count >= Number(item.params.maxWakeups)))) throw new Error("Cannot resume an archived task or exhausted workflow; update its limits or arm a new instance");
    const at = now.toISOString();
    const next = state === "active" && row.type === "schedule-steer"
      ? new Date(Math.max(now.getTime(), Date.parse(String(item.params.scheduledAt)))).toISOString()
      : at;
    cancelWorkflowMessages(id);
    db.run("UPDATE workflows SET state = ?, reason = ?, revision = revision + 1, context_n = ?, next_check_at = ?, updated_at = ?, failures = 0 WHERE id = ?",
      [state, reason, task?.context_n ?? row.context_n, next, at, id]);
    recordWorkflow(id, state, reason, at);
    return workflow(getWorkflow(id)!);
  })();
  announceWorkflow(result.taskId);
  return result;
}
export function updateWorkflow(id: string, params: WorkflowParams, revision: number, now = new Date()): Workflow {
  const result = db.transaction(() => {
    const row = getWorkflow(id);
    if (!row || row.state === "completed") throw new Error("Only unfinished workflows can be edited");
    if (row.revision !== revision) throw new Error("Workflow changed; refresh before saving");
    cancelWorkflowMessages(id);
    const scheduled = row.type === "schedule-steer" ? Date.parse(String(params.scheduledAt)) : null;
    if (scheduled !== null && scheduled <= now.getTime()) throw new Error("Scheduled time must be in the future");
    const expiry = scheduled === null
      ? new Date(Date.parse(row.created_at) + Number(params.lifetimeHours) * 3_600_000).toISOString()
      : "9999-12-31T23:59:59.999Z";
    const next = scheduled === null ? now.toISOString() : new Date(scheduled).toISOString();
    db.run("UPDATE workflows SET params_json = ?, revision = revision + 1, next_check_at = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(params), next, expiry, now.toISOString(), id]);
    recordWorkflow(id, "configured", "Parameters updated; pending instructions cancelled", now.toISOString());
    return workflow(getWorkflow(id)!);
  })();
  announceWorkflow(result.taskId);
  return result;
}
/** Built-ins Wisp shipped and then withdrew still have rows; none may sit paused forever. */
export function retireWorkflowTypes(retired: Record<string, string>, now = new Date()): void {
  const types = Object.keys(retired);
  const rows = db.query(`SELECT id, type FROM workflows WHERE state != 'completed' AND type IN (${types.map(() => "?").join(", ")})`)
    .all(...types) as { id: string; type: string }[];
  for (const row of rows) changeWorkflowState(row.id, "completed", `${retired[row.type]} was removed from Wisp`, now);
}
export function pauseTaskWorkflows(taskId: string): void {
  const task = getTask(taskId);
  for (const item of listWorkflows(taskId)) {
    // An autopilot row the agent-switch trigger just paused is about to be
    // reactivated, so it takes the hold too.
    const followed = item.type === AUTOPILOT_TYPE && item.state === "paused" && item.reason === CONTEXT_CHANGE_PAUSE;
    if (item.state !== "active" && !followed) continue;
    if (item.type === AUTOPILOT_TYPE) {
      // Stop HOLDS autopilot rather than pausing it: a person stepped in, so
      // nothing acts until their next turn has finished, and then it carries
      // on by itself. Stopping only a background process leaves the task
      // `done`, which is exactly when an unheld auto-merge would fire.
      // A queued auto-fix round goes first: its cancel trigger restores the
      // checkpoint the round was reserved against, which would wipe a hold
      // written before it. The hold is then written onto the restored one.
      const queued = db.query("SELECT id FROM task_messages WHERE workflow_id = ? AND status = 'queued' AND claim IS NULL").all(item.id) as { id: string }[];
      cancelWorkflowMessages(item.id);
      for (const message of queued) emit({ type: "message", taskId, messageId: message.id });
      const row = getWorkflow(item.id)!;
      const { pending: _pending, sendNow: _sendNow, ...kept } = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
      const checkpoint = { ...kept, stopHold: { turnCount: task?.turn_count ?? 0 }, state: "held" };
      const at = new Date().toISOString();
      db.run("UPDATE workflows SET checkpoint_json = ?, reason = CASE WHEN state = 'active' THEN ? ELSE reason END, revision = revision + 1, updated_at = ? WHERE id = ?",
        [JSON.stringify(checkpoint), "Held — you pressed Stop; continues after your next turn", at, item.id]);
      recordWorkflow(item.id, "held", "Held after Stop", at);
      announceWorkflow(taskId);
      continue;
    }
    changeWorkflowState(item.id, "paused", "Task stopped by user");
  }
}
export function dueWorkflows(now: Date): WorkflowRow[] {
  // autopilot has its own loop (autopilot/runtime.ts)
  return db.query("SELECT * FROM workflows WHERE state = 'active' AND type != ? AND (next_check_at <= ? OR expires_at <= ?) ORDER BY next_check_at LIMIT 100").all(AUTOPILOT_TYPE, now.toISOString(), now.toISOString()) as WorkflowRow[];
}
export function saveEvaluation(row: WorkflowRow, result: WorkflowDecision, now: Date, failures = 0, notify = true): boolean {
  const current = getWorkflow(row.id);
  if (!current || current.state !== "active" || current.revision !== row.revision) return false;
  const minutes = row.type === "schedule-steer" ? 1 : Number(workflow(row).params.everyMinutes);
  const delay = Math.min(Math.max(minutes * 60_000, failures ? 60_000 * 2 ** Math.min(failures, 8) : 0), 86_400_000);
  db.run(`UPDATE workflows SET checkpoint_json = ?, reason = ?, check_count = check_count + 1,
    failures = ?, last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
  [JSON.stringify(result.checkpoint), result.reason, failures, now.toISOString(), new Date(now.getTime() + delay).toISOString(), now.toISOString(), row.id]);
  if (result.action === "wait" && row.reason !== result.reason) recordWorkflow(row.id, failures ? "error" : "wait", result.reason, now.toISOString());
  if (notify) announceWorkflow(row.task_id);
  return true;
}
/** Complete a one-shot wake without cancelling the message it just reserved. */
export function completeWorkflowWake(row: WorkflowRow, reason: string, now: Date): Workflow | null {
  const result = db.transaction(() => {
    const current = getWorkflow(row.id);
    if (!current || current.state !== "active" || current.revision !== row.revision) return null;
    const at = now.toISOString();
    db.run("UPDATE workflows SET state = 'completed', reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      [reason, at, row.id]);
    // A fired schedule becomes an ordinary durable task message. That lets a
    // non-live running task consume it on its next turn, and lets the user
    // edit or cancel it after the one-shot workflow has completed.
    if (row.type === "schedule-steer") db.run("UPDATE task_messages SET workflow_id = NULL WHERE workflow_id = ?", [row.id]);
    recordWorkflow(row.id, "completed", reason, at);
    return workflow(getWorkflow(row.id)!);
  })();
  if (result) announceWorkflow(result.taskId);
  return result;
}
export function seenWake(id: string, key: string): boolean {
  const entry = db.query(`SELECT m.status, m.delivery_uncertain FROM workflow_wakes w
    JOIN task_messages m ON m.id = w.message_id WHERE w.workflow_id = ? AND w.event_key = ?`).get(id, key) as { status: string; delivery_uncertain: number } | null;
  return entry !== null && (entry.status === "delivered" || Boolean(entry.delivery_uncertain));
}
/** No awaits: checkpoint, deduplication and the message commit as one local action. */
export function reserveWorkflowWake(row: WorkflowRow, result: WorkflowDecision, prompt: string, now: Date): string | null {
  const messageId = db.transaction(() => {
    const current = getWorkflow(row.id), task = getTask(row.task_id);
    if (!current || current.state !== "active" || current.revision !== row.revision || !task ||
      task.archived || task.context_n !== row.context_n || !result.key || seenWake(row.id, result.key)) return null;
    const id = randomId("m", 12);
    createTaskMessage({ id, taskId: task.id, text: prompt, attachmentHash: "" }, false);
    db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [row.id, id]);
    db.run(`INSERT INTO workflow_wakes(workflow_id, event_key, message_id, prior_checkpoint_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(workflow_id, event_key) DO UPDATE SET message_id = excluded.message_id, prior_checkpoint_json = excluded.prior_checkpoint_json`,
    [row.id, result.key, id, row.checkpoint_json]);
    db.run("UPDATE workflows SET wake_count = wake_count + 1 WHERE id = ?", [row.id]);
    saveEvaluation(row, result, now, 0, false);
    recordWorkflow(row.id, "wake", result.reason, now.toISOString(), id);
    return getTaskMessage(id)?.id ?? null;
  })();
  if (messageId) {
    emit({ type: "message", taskId: row.task_id, messageId });
    announceWorkflow(row.task_id);
  }
  return messageId;
}
