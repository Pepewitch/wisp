import { getTask } from "../store";
import { AUTOPILOT_TYPE } from "../autopilot/type";
import { isRecord } from "../validate";
import { validateWorkflowParams } from "../workflows/definitions";
import { installedWorkflows, workflowById } from "../workflows/plugins";
import { changeWorkflowState, createWorkflow, getWorkflow, listWorkflows, updateWorkflow, workflow, workflowHistory } from "../workflows/store";
import { err, json, jsonObjectBody } from "./http";
import { isAgentActor, recordAudit, requestActor } from "../task-audit";

/** Merge permission is a person's to give: an agent may keep one it was given, never grant itself one. */
const MERGE_IS_A_PERSONS = "Only a person may allow a merge: an agent cannot turn allowMerge on. Ask the person, or leave it off.";

async function taskWorkflows(req: Request, taskId: string): Promise<Response> {
  const task = getTask(taskId);
  if (!task) return err("Task not found", 404);
  // autopilot rows share the table but are driven by their own toggle and API
  if (req.method === "GET") return json(listWorkflows(task.id).filter(item => item.type !== AUTOPILOT_TYPE));
  if (req.method !== "POST") return err("Method not allowed", 405);
  const body = await jsonObjectBody(req);
  if (body instanceof Response) return body;
  const definition = workflowById(body.type)?.definition;
  if (!definition) return err("Unknown workflow type", 400);
  const actor = requestActor(req);
  const asked = isRecord(body.params) ? body.params : {};
  if (isAgentActor(actor) && asked.allowMerge === true) return err(MERGE_IS_A_PERSONS, 409);
  // a heartbeat allows a merge by default; one an agent starts does not, unless a person turns it on later
  const params = validateWorkflowParams(definition, isAgentActor(actor) && definition.parameters.some((p) => p.key === "allowMerge")
    ? { ...asked, allowMerge: false } : body.params ?? {});
  const created = createWorkflow(task.id, definition, params, new Date(), actor);
  recordAudit(task.id, "workflow-start", actor, `${created.id} (${created.type})`);
  return json(created, 201);
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
    if (row.type === AUTOPILOT_TYPE) return err("Auto-merge is controlled from the task (PUT /api/tasks/:id/autopilot)", 409);
    const body = await jsonObjectBody(req);
    if (body instanceof Response) return body;
    const audit = (action: "workflow-update" | "workflow-pause" | "workflow-resume" | "workflow-complete"): void =>
      recordAudit(row.task_id, action, requestActor(req), `${row.id} (${row.type})`);
    if (req.method === "POST" && match[2]) {
      const action = match[2];
      const actor = requestActor(req);
      const changed = changeWorkflowState(row.id, action === "resume" ? "active" : action === "pause" ? "paused" : "completed",
        action === "resume" ? "Resumed; waiting for a fresh check" : action === "pause" ? "Paused by request" : "Completed by request",
        new Date(), action === "resume" && isAgentActor(actor) ? actor : null);
      audit(`workflow-${action as "pause" | "resume" | "complete"}`);
      return json(changed);
    }
    if (req.method === "PATCH" && !match[2]) {
      const def = workflowById(row.type)?.definition;
      if (!def || def.version !== row.version) return err("Workflow definition changed; arm a new instance", 409);
      if (!isRecord(body.params) || !Number.isSafeInteger(body.revision)) return err("params and revision are required", 400);
      const params = validateWorkflowParams(def, { ...workflow(row).params, ...body.params });
      const actor = requestActor(req);
      if (params.allowMerge === true && workflow(row).params.allowMerge !== true && isAgentActor(actor)) return err(MERGE_IS_A_PERSONS, 409);
      const updated = updateWorkflow(row.id, params, Number(body.revision), new Date(), actor);
      audit("workflow-update");
      return json(updated);
    }
    return err("Method not allowed", 405);
  } catch (error) {
    return err(error instanceof Error ? error.message : "Workflow operation failed", 400);
  }
}
