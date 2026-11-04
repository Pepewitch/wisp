/**
 * POST /api/tasks/:id/report-ack: the parent has read this subtask's result,
 * so its waiting `done` turn reports are handled (#527). The rule is
 * subtask-report-ack.ts's; this parses, answers and records who asked.
 */
import type { ReportAckResponse } from "../../../shared/api/task";
import { ackReports } from "../subtask-report-ack";
import { recordAudit, requestActor } from "../task-audit";
import type { Task } from "../types";
import { typeName } from "../validate";
import { err, json, jsonObjectBody } from "./http";

export async function reportAckRoute(task: Task, req: Request): Promise<Response> {
  const parsed = await jsonObjectBody(req);
  if (parsed instanceof Response) return parsed;
  const through = parsed.throughTurn;
  if (through !== undefined && (typeof through !== "number" || !Number.isInteger(through) || through < 1)) {
    return err(`throughTurn must be a turn number (a positive integer), got ${typeName(through)}`, 400);
  }
  if (!task.parent_task_id) return err(`task ${task.id} is not a subtask: it has no parent to report to`, 409);
  const ack = ackReports(task.id, through);
  if (ack.handled > 0) {
    recordAudit(task.parent_task_id, "report-ack", requestActor(req), `${task.id} through turn ${ack.through}: ${ack.handled} handled`);
  }
  return json<ReportAckResponse>(ack);
}
