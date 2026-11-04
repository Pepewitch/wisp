/**
 * POST /api/tasks/:id/report-ack: the parent has read this subtask's result,
 * so its waiting `done` turn reports are handled (#527). The rule is
 * subtask-report-ack.ts's; this parses, answers and records who asked.
 */
import type { ReportAckResponse } from "../../../shared/api/task";
import { ackReports } from "../subtask-report-ack";
import { isAgentActor, recordAudit, requestActor } from "../task-audit";
import type { Task } from "../types";
import { typeName } from "../validate";
import { err, json, jsonObjectBody } from "./http";

export async function reportAckRoute(task: Task, req: Request): Promise<Response> {
  const parsed = await jsonObjectBody(req);
  if (parsed instanceof Response) return parsed;
  const through = parsed.throughTurn;
  if (typeof through !== "number" || !Number.isInteger(through) || through < 1) {
    return err(`throughTurn is required: the turn number the parent read (a positive integer), got ${typeName(through)}`, 400);
  }
  if (!task.parent_task_id) return err(`task ${task.id} is not a subtask: it has no parent to report to`, 409);
  const actor = requestActor(req);
  // a person may; of the agents, only the parent's: a child, or a sibling, must not drop its reports
  if (isAgentActor(actor) && actor !== `agent:${task.parent_task_id}`) {
    return err(`only the parent task (${task.parent_task_id}) or a person may mark ${task.id}'s reports handled`, 403);
  }
  const ack = ackReports(task.id, through);
  if (ack.handled > 0) {
    recordAudit(task.parent_task_id, "report-ack", actor, `${task.id} through turn ${ack.through}: ${ack.handled} handled`);
  }
  return json<ReportAckResponse>(ack);
}
