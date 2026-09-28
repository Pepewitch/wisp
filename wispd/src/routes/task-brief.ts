/**
 * GET /api/tasks/:id/brief            the latest report, its turn, and why it reads as it does
 * PUT /api/tasks/:id/brief            { runId, expectedRevision, payload } — an agent's publication
 * PUT /api/tasks/:id/brief-settings   { enabled } — the per-task switch; idempotent
 *
 * Reading never generates. Publication answers a disabled, archived or ended
 * run with a SUCCESSFUL `skipped` — the agent is told the save did not happen
 * and that there is nothing to retry — while a binding for another task or
 * another daemon is an error, never a quiet success.
 */
import { briefErrorLine } from "../../../shared/task-brief"
import type { AdapterDef } from "../adapters"
import { briefSettings, briefView, publishBrief, setBriefEnabled } from "../brief-store"
import type { WispConfig } from "../config"
import { emit } from "../events"
import { getTask } from "../store"
import { updateTaskAndEmit } from "../task-update"
import { typeName } from "../validate"
import { boundedJsonObjectBody, err, json } from "./http"

export const BRIEF_PATH = /^\/api\/tasks\/([a-z0-9]+)\/(brief|brief-settings)$/

/** The payload's own 12 KiB limit, plus room for the envelope around it. */
export const BRIEF_ENVELOPE_BYTES = 16 * 1024

function unknownField(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return `unknown field '${key}'`
  return null
}

async function publish(req: Request, taskId: string, cfg: WispConfig): Promise<Response> {
  const body = await boundedJsonObjectBody(req, BRIEF_ENVELOPE_BYTES)
  if (body instanceof Response) return body
  const unknown = unknownField(body, ["runId", "expectedRevision", "payload"])
  if (unknown) return err(unknown, 400)
  if (typeof body.runId !== "string" || body.runId === "") {
    return err(`runId must be a non-empty string, got ${typeName(body.runId)}`, 400)
  }
  const expected = body.expectedRevision
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
    return err("expectedRevision must be a non-negative integer", 400)
  }
  if (!("payload" in body)) return err("payload is required", 400)
  const result = publishBrief(taskId, body.runId, expected, body.payload, cfg.instanceId)
  switch (result.kind) {
    case "saved":
      emit({ type: "brief", taskId })
      return json(result)
    case "unchanged":
    case "skipped":
      return json(result)
    case "conflict":
      return json({ kind: "conflict", error: "a different revision of this turn's brief is already saved" }, 409)
    case "forbidden":
      return err(result.message, 403)
    case "invalid":
      return json({ error: briefErrorLine(result.check), field: result.check.field }, 400)
  }
}

async function settings(req: Request, taskId: string, adapters: Readonly<Record<string, AdapterDef>>): Promise<Response> {
  const body = await boundedJsonObjectBody(req, 1024)
  if (body instanceof Response) return body
  const unknown = unknownField(body, ["enabled"])
  if (unknown) return err(unknown, 400)
  if (typeof body.enabled !== "boolean") return err(`enabled must be a boolean, got ${typeName(body.enabled)}`, 400)
  const task = getTask(taskId)!
  if (task.archived) return err("an archived task keeps its briefs but can no longer change the setting", 409)
  if (body.enabled && adapters[task.harness]?.briefs !== true) {
    return err(`harness '${task.harness}' can't write task briefs`, 400)
  }
  const before = task.brief_enabled === 1
  const result = setBriefEnabled(taskId, body.enabled)!
  if (before !== result.enabled) {
    // the task row's `briefEnabled` changed: every client's task list refreshes
    updateTaskAndEmit(taskId, {})
    emit({ type: "brief", taskId })
  }
  return json(result)
}

export async function briefRoute(
  req: Request,
  path: string,
  cfg: WispConfig,
  adapters: Readonly<Record<string, AdapterDef>>,
): Promise<Response> {
  const match = path.match(BRIEF_PATH)!
  const taskId = match[1]!
  const task = getTask(taskId)
  if (!task) return err("Task not found", 404)
  if (match[2] === "brief-settings") {
    if (req.method === "GET") return json(briefSettings(task))
    if (req.method !== "PUT") return err("Method not allowed", 405)
    return settings(req, taskId, adapters)
  }
  if (req.method === "GET") return json(briefView(task, adapters))
  if (req.method !== "PUT") return err("Method not allowed", 405)
  return publish(req, taskId, cfg)
}
