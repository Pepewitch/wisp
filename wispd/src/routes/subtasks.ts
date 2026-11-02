/**
 * The subtask parts of the HTTP API: the create request's fields, and
 * GET /api/tasks/:id/subtasks. Every rule is the domain's
 * (domain/subtask-create.ts); this only parses and serves.
 */
import type { ApiSubtask } from "../../../shared/api/task";
import type { SubtaskRequest } from "../domain/subtask-create";
import { subtaskSummaries } from "../subtasks";
import { SUBTASK_KINDS, type SubtaskKind, type Task } from "../types";
import { typeName } from "../validate";
import { err, json } from "./http";

export interface SubtaskBody {
  parentTaskId?: unknown;
  subtaskKind?: unknown;
  report?: unknown;
  /** wait for the parent's running cap instead of being refused (task-launch.ts) */
  queue?: unknown;
}

/** The create request's subtask fields, checked for shape; a combination the domain cannot judge is refused here. */
export function subtaskBodyError(body: SubtaskBody & { repoPath?: unknown }): Response | null {
  if (body.queue !== undefined && typeof body.queue !== "boolean") return err(`queue must be a boolean, got ${typeName(body.queue)}`, 400);
  if (body.parentTaskId === undefined) {
    if (body.subtaskKind !== undefined || body.report !== undefined) return err("subtaskKind and report need parentTaskId", 400);
    if (body.queue === true) return err("queue needs parentTaskId: a subtask waits for its parent's running cap", 400);
    return null;
  }
  if (typeof body.parentTaskId !== "string" || body.parentTaskId === "") {
    return err(`parentTaskId must be a task id, got ${typeName(body.parentTaskId)}`, 400);
  }
  if (body.subtaskKind !== undefined && !(SUBTASK_KINDS as readonly unknown[]).includes(body.subtaskKind)) {
    return err(`subtaskKind must be one of ${SUBTASK_KINDS.join(", ")}`, 400);
  }
  if (body.report !== undefined && typeof body.report !== "boolean") return err(`report must be a boolean, got ${typeName(body.report)}`, 400);
  return null;
}

export function subtaskRequest(body: SubtaskBody): SubtaskRequest | undefined {
  if (typeof body.parentTaskId !== "string") return undefined;
  return {
    parentId: body.parentTaskId,
    ...(body.subtaskKind !== undefined ? { kind: body.subtaskKind as SubtaskKind } : {}),
    report: body.report === true,
  };
}

/** GET /api/tasks/:id/subtasks: every child, archived ones too, newest first. */
export function subtasksRoute(task: Task): Response {
  return json<ApiSubtask[]>(subtaskSummaries(task.id));
}
