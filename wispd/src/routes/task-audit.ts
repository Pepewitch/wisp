import type { TaskAuditResponse } from "../../../shared/api/task-audit";
import { AUDIT_READ_MAX, taskAudit } from "../task-audit";
import type { Task } from "../types";
import { err, json } from "./http";

/** GET /api/tasks/:id/audit[?limit=1-500]: who did what to the task, newest first (default 100). */
export function taskAuditRoute(task: Task, url: URL): Response {
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? 100 : Number(raw);
  if (!/^\d+$/.test(raw ?? "100") || limit < 1 || limit > AUDIT_READ_MAX) {
    return err(`limit must be a whole number from 1 to ${AUDIT_READ_MAX}`, 400);
  }
  return json<TaskAuditResponse>({ entries: taskAudit(task.id, limit) }, 200, { "cache-control": "private, no-store" });
}
