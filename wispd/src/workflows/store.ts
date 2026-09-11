import type { Workflow, WorkflowDecision, WorkflowDefinition, WorkflowHistory, WorkflowParams, WorkflowState } from "../../../shared/workflows";
import { db } from "../store-database";
import { emit } from "../events";
import { createTaskMessage, getTask, getTaskMessage, randomId } from "../store";

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
    const next = new Date(now.getTime() + (def.id === "heartbeat" ? Number(params.everyMinutes) * 60_000 : 0)).toISOString();
    db.run(`INSERT INTO workflows(id, task_id, type, version, params_json, state, reason, context_n, next_check_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'Waiting for first check', ?, ?, ?, ?, ?)`,
    [id, taskId, def.id, def.version, JSON.stringify(params), task.context_n, next, new Date(now.getTime() + Number(params.lifetimeHours) * 3_600_000).toISOString(), at, at]);
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
    if (state === "active" && (!task || task.archived || Date.parse(row.expires_at) <= now.getTime() ||
      row.wake_count >= Number(workflow(row).params.maxWakeups))) throw new Error("Cannot resume an archived task or exhausted workflow; update its limits or arm a new instance");
    const at = now.toISOString();
    cancelWorkflowMessages(id);
    db.run("UPDATE workflows SET state = ?, reason = ?, revision = revision + 1, context_n = ?, next_check_at = ?, updated_at = ?, failures = 0 WHERE id = ?",
      [state, reason, task?.context_n ?? row.context_n, at, at, id]);
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
    const previous = workflow(row).params;
    // Retargeting is a new automation, not an edit to already observed evidence.
    if (previous.prUrl !== params.prUrl) throw new Error("Arm a new workflow to watch a different PR");
    cancelWorkflowMessages(id);
    const expiry = new Date(Date.parse(row.created_at) + Number(params.lifetimeHours) * 3_600_000).toISOString();
    db.run("UPDATE workflows SET params_json = ?, revision = revision + 1, next_check_at = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(params), now.toISOString(), expiry, now.toISOString(), id]);
    recordWorkflow(id, "configured", "Parameters updated; pending instructions cancelled", now.toISOString());
    return workflow(getWorkflow(id)!);
  })();
  announceWorkflow(result.taskId);
  return result;
}
export function pauseTaskWorkflows(taskId: string): void {
  for (const item of listWorkflows(taskId)) if (item.state === "active") changeWorkflowState(item.id, "paused", "Task stopped by user");
}
export function dueWorkflows(now: Date): WorkflowRow[] {
  return db.query("SELECT * FROM workflows WHERE state = 'active' AND (next_check_at <= ? OR expires_at <= ?) ORDER BY next_check_at LIMIT 100").all(now.toISOString(), now.toISOString()) as WorkflowRow[];
}
export function saveEvaluation(row: WorkflowRow, result: WorkflowDecision, now: Date, failures = 0, notify = true): boolean {
  const current = getWorkflow(row.id);
  if (!current || current.state !== "active" || current.revision !== row.revision) return false;
  const minutes = Number(workflow(row).params.everyMinutes);
  const delay = Math.min(Math.max(minutes * 60_000, failures ? 60_000 * 2 ** Math.min(failures, 8) : 0), 86_400_000);
  db.run(`UPDATE workflows SET checkpoint_json = ?, reason = ?, check_count = check_count + 1,
    failures = ?, last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE id = ?`,
  [JSON.stringify(result.checkpoint), result.reason, failures, now.toISOString(), new Date(now.getTime() + delay).toISOString(), now.toISOString(), row.id]);
  if (result.action === "wait" && row.reason !== result.reason) recordWorkflow(row.id, failures ? "error" : "wait", result.reason, now.toISOString());
  if (notify) announceWorkflow(row.task_id);
  return true;
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
