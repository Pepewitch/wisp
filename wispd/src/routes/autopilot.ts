/**
 * GET  /api/tasks/:id/autopilot          the task's auto-merge status and reason
 * PUT  /api/tasks/:id/autopilot          { autoMerge?, autoFix? } — idempotent
 * POST /api/tasks/:id/autopilot/resume   resume a pause, or release a Stop hold
 */
import type { AutopilotUpdate } from "../../../shared/autopilot"
import { AutopilotError, autopilotStatus, resumeAutopilot, setAutopilot } from "../autopilot/store"
import { getTask } from "../store"
import { typeName } from "../validate"
import { err, json, jsonObjectBody } from "./http"

export const AUTOPILOT_PATH = /^\/api\/tasks\/([a-z0-9]+)\/autopilot(?:\/(resume))?$/

export function autopilotUpdateError(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) if (key !== "autoMerge" && key !== "autoFix") return `unknown field '${key}'`
  for (const key of ["autoMerge", "autoFix"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return `${key} must be a boolean, got ${typeName(body[key])}`
  }
  return null
}

export async function autopilotRoute(req: Request, path: string): Promise<Response> {
  const match = path.match(AUTOPILOT_PATH)!
  const taskId = match[1]!
  if (!getTask(taskId)) return err("Task not found", 404)
  try {
    if (match[2] === "resume") {
      if (req.method !== "POST") return err("Method not allowed", 405)
      return json(resumeAutopilot(taskId))
    }
    if (req.method === "GET") return json(autopilotStatus(taskId))
    if (req.method !== "PUT") return err("Method not allowed", 405)
    const body = await jsonObjectBody(req)
    if (body instanceof Response) return body
    const invalid = autopilotUpdateError(body)
    if (invalid) return err(invalid, 400)
    return json(setAutopilot(taskId, body as AutopilotUpdate))
  } catch (error) {
    if (error instanceof AutopilotError) return err(error.message, error.status)
    throw error
  }
}
