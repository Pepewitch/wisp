import { getTask } from "../store";
import { isRecord } from "../validate";
import { validateWorkflowParams } from "../workflows/definitions";
import { installedWorkflows, workflowById } from "../workflows/plugins";
import { changeWorkflowState, createWorkflow, getWorkflow, listWorkflows, updateWorkflow, workflow, workflowHistory } from "../workflows/store";
import { err, json, jsonObjectBody } from "./http";

async function taskWorkflows(req: Request, taskId: string): Promise<Response> {
  const task = getTask(taskId);
  if (!task) return err("Task not found", 404);
  if (req.method === "GET") return json(listWorkflows(task.id));
  if (req.method !== "POST") return err("Method not allowed", 405);
  const body = await jsonObjectBody(req);
  if (body instanceof Response) return body;
  const definition = workflowById(body.type)?.definition;
  if (!definition) return err("Unknown workflow type", 400);
  return json(createWorkflow(task.id, definition, validateWorkflowParams(definition, body.params ?? {})), 201);
}

export async function workflowRoute(req: Request, path: string): Promise<Response> {
  try {
    if (path === "/api/workflow-types" && req.method === "GET") return json(installedWorkflows().map(p => p.definition));
    const tasks = path.match(/^\/api\/tasks\/([a-z0-9]+)\/workflows$/);
    if (tasks) return await taskWorkflows(req, tasks[1]!);
    const match = path.match(/^\/api\/workflows\/([a-z0-9]+)(?:\/(pause|resume|complete))?$/);
    if (!match) return err("Not found", 404);
    const row = getWorkflow(match[1]!);
    if (!row) return err("Workflow not found", 404);
    if (req.method === "GET" && !match[2]) return json({ workflow: workflow(row), history: workflowHistory(row.id) });
    const body = await jsonObjectBody(req);
    if (body instanceof Response) return body;
    if (req.method === "POST" && match[2]) {
      const action = match[2];
      return json(changeWorkflowState(row.id, action === "resume" ? "active" : action === "pause" ? "paused" : "completed",
        action === "resume" ? "Resumed; waiting for a fresh check" : action === "pause" ? "Paused by request" : "Completed by request"));
    }
    if (req.method === "PATCH" && !match[2]) {
      const def = workflowById(row.type)?.definition;
      if (!def || def.version !== row.version) return err("Workflow definition changed; arm a new instance", 409);
      if (!isRecord(body.params) || !Number.isSafeInteger(body.revision)) return err("params and revision are required", 400);
      return json(updateWorkflow(row.id, validateWorkflowParams(def, { ...workflow(row).params, ...body.params }), Number(body.revision)));
    }
    return err("Method not allowed", 405);
  } catch (error) {
    return err(error instanceof Error ? error.message : "Workflow operation failed", 400);
  }
}
