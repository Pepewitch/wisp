/**
 * The task audit: which actor took each consequential action on a task, so
 * "who archived this?" or "who sent that message?" has an answer.
 *
 * Messages a workflow or autopilot wrote are not copied here. Their
 * `task_messages` row already names its origin and workflow, and the read
 * joins them in as `send` entries, so there is one record of each.
 *
 * Rows go with the task on permanent deletion (task-retention.ts), and each
 * task keeps its newest AUDIT_KEEP entries.
 */
import type { AutopilotStatus } from "../../shared/autopilot";
import type { TaskAuditAction, TaskAuditActor, TaskAuditEntry } from "../../shared/api/task-audit";
import { AUTOPILOT_TYPE } from "./autopilot/type";
import { db } from "./store";
import type { SendResult } from "./types";

export type { TaskAuditAction, TaskAuditActor, TaskAuditEntry };

/** Entries kept per task; the oldest go first. */
export const AUDIT_KEEP = 1000;
/** The most one read returns. */
export const AUDIT_READ_MAX = 500;
const DETAIL_MAX = 500;

export const CLIENT_HEADER = "x-wisp-client";
export const TASK_HEADER = "x-wisp-task";
const CLIENTS = new Set(["web", "desktop", "cli"]);
const TASK_ID = /^[a-z0-9]{1,32}$/;

/**
 * The actor a request reports. The browser app sends `X-Wisp-Client: web`,
 * the Desktop proxy sets `desktop` on everything it relays, and the CLI sends
 * `cli` plus `X-Wisp-Task` when it runs inside a Wisp task's turn (which is
 * where `WISP_TASK_ID` is set), so an agent driving Wisp reads as
 * `agent:<its task>`.
 *
 * This is a self-report for accountability, NOT authentication: any holder of
 * the token can send any value. It must never gate or widen what a request may
 * do; it only records what the caller said it was. Anything unrecognised is
 * `api`.
 */
export function requestActor(req: Request): TaskAuditActor {
  const client = req.headers.get(CLIENT_HEADER)?.trim().toLowerCase() ?? "";
  if (!CLIENTS.has(client)) return "api";
  const task = req.headers.get(TASK_HEADER)?.trim() ?? "";
  return client === "cli" && TASK_ID.test(task) ? `agent:${task}` : client;
}

export function workflowActor(workflowId: string, type: string): TaskAuditActor {
  return type === AUTOPILOT_TYPE ? "autopilot" : `workflow:${workflowId}`;
}

/** One row, then the per-task trim. Runs inside the caller's transaction. */
function insertAudit(taskId: string, action: TaskAuditAction, actor: TaskAuditActor, detail: string | null, at: Date): void {
  db.query("INSERT INTO task_audit (task_id, at, action, actor, detail) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    at.toISOString(),
    action,
    actor.slice(0, 80),
    detail === null ? null : detail.slice(0, DETAIL_MAX),
  );
  const cutoff = db
    .query("SELECT id FROM task_audit WHERE task_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?")
    .get(taskId, AUDIT_KEEP) as { id: number } | null;
  if (cutoff) db.query("DELETE FROM task_audit WHERE task_id = ? AND id <= ?").run(taskId, cutoff.id);
}

/**
 * Never throws: the action being recorded has already happened, and failing
 * its request now would misreport the outcome.
 */
function writeAudit(taskId: string, action: TaskAuditAction, actor: TaskAuditActor, write: () => void): void {
  try {
    db.transaction(write)();
  } catch (error) {
    console.warn(`[wisp] task ${taskId}: could not record ${action} by ${actor}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Record one action. Never throws. */
export function recordAudit(
  taskId: string,
  action: TaskAuditAction,
  actor: TaskAuditActor,
  detail: string | null = null,
  at = new Date(),
): void {
  writeAudit(taskId, action, actor, () => insertAudit(taskId, action, actor, detail, at));
}

/**
 * A send, once per message: a client retrying with its clientMessageId is
 * handed the same message back, which is not a second send. Never throws.
 */
export function recordSendAudit(taskId: string, result: SendResult, actor: TaskAuditActor): void {
  const detail = `message ${result.message.id}`;
  const action = result.disposition === "steered" ? "steer" : "send";
  writeAudit(taskId, action, actor, () => {
    const seen = db
      .query("SELECT 1 FROM task_audit WHERE task_id = ?1 AND action IN ('send', 'steer') AND (detail = ?2 OR instr(detail, ?2 || ' ') = 1)")
      .get(taskId, detail);
    if (!seen) insertAudit(taskId, action, actor, result.interrupted ? `${detail} · interrupted the running turn` : detail, new Date());
  });
}

/** Which auto-merge / auto-fix switches moved, or null when neither did. */
export function autopilotSwitchDetail(before: AutopilotStatus | null, after: AutopilotStatus): string | null {
  const moved = [
    (before?.autoMerge ?? false) !== after.autoMerge && `auto-merge ${after.autoMerge ? "on" : "off"}`,
    (before?.autoFix ?? false) !== after.autoFix && `auto-fix ${after.autoFix ? "on" : "off"}`,
  ].filter((part): part is string => typeof part === "string");
  return moved.length > 0 ? moved.join(", ") : null;
}

/**
 * Newest first: the recorded actions, and every message a workflow or
 * autopilot queued, unless it was cancelled with no chance it arrived (a person's
 * cancellation is its own `cancel` entry).
 */
export function taskAudit(taskId: string, limit = 100): TaskAuditEntry[] {
  const bounded = Math.max(1, Math.min(AUDIT_READ_MAX, Math.trunc(limit)));
  const rows = db.query(`
SELECT at, action, actor, detail, 0 AS source, id FROM task_audit WHERE task_id = ?1
UNION ALL
SELECT m.created_at AS at, 'send' AS action,
  CASE WHEN w.type = ?2 THEN 'autopilot' ELSE 'workflow:' || m.workflow_id END AS actor,
  'message ' || m.id AS detail, 1 AS source, m.rowid AS id
FROM task_messages m LEFT JOIN workflows w ON w.id = m.workflow_id
WHERE m.task_id = ?1 AND m.workflow_id IS NOT NULL AND (m.status <> 'cancelled' OR m.delivery_uncertain = 1)
ORDER BY at DESC, source DESC, id DESC
LIMIT ?3`).all(taskId, AUTOPILOT_TYPE, bounded) as (TaskAuditEntry & { source: number; id: number })[];
  return rows.map(({ at, action, actor, detail }) => ({ at, action, actor, detail }));
}
