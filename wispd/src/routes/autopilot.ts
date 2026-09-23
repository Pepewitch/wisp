/**
 * GET  /api/tasks/:id/autopilot             the task's auto-merge / auto-fix status and reason
 * PUT  /api/tasks/:id/autopilot             { autoMerge?, autoFix? } — idempotent
 * POST /api/tasks/:id/autopilot/resume      resume a pause, or release a Stop hold
 * POST /api/tasks/:id/autopilot/send-now    send a pending auto-fix round without its delay
 * POST /api/tasks/:id/autopilot/skip        never send the pending round's evidence
 */
import type { AutopilotUpdate } from "../../../shared/autopilot"
import { AutopilotError, autopilotStatus, resumeAutopilot, sendPendingFix, setAutopilot, skipPendingFix } from "../autopilot/store"
import { getTask } from "../store"
import { typeName } from "../validate"
import { err, json, jsonObjectBody } from "./http"

export const AUTOPILOT_PATH = /^\/api\/tasks\/([a-z0-9]+)\/autopilot(?:\/(resume|send-now|skip))?$/

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
    if (match[2]) {
      if (req.method !== "POST") return err("Method not allowed", 405)
      const act = { resume: resumeAutopilot, "send-now": sendPendingFix, skip: skipPendingFix }[match[2] as "resume" | "send-now" | "skip"]
      return json(act(taskId))
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
