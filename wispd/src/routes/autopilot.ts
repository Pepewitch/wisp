/**
 * GET  /api/tasks/:id/autopilot             the task's auto-merge / auto-fix status and reason
 * PUT  /api/tasks/:id/autopilot             { autoMerge?, autoFix? } — idempotent
 * POST /api/tasks/:id/autopilot/resume      resume a pause, or release a Stop hold
 * POST /api/tasks/:id/autopilot/send-now    send a pending auto-fix round without its delay
 * POST /api/tasks/:id/autopilot/skip        never send the pending round's evidence
 * GET  /api/tasks/:id/autopilot/history     what it did, newest first (AutopilotHistoryResponse)
 */
import type { AutopilotUpdate } from "../../../shared/autopilot"
import type { AutopilotHistoryResponse } from "../../../shared/api/autopilot"
import { AutopilotError, autopilotHistory, autopilotRow, autopilotStatus, checkpointOf, resumeAutopilot, sendPendingFix, setAutopilot, skipPendingFix } from "../autopilot/store"
import { getTask } from "../store"
import { autopilotSwitchDetail, recordAudit, requestActor } from "../task-audit"
import { typeName } from "../validate"
import { err, json, jsonObjectBody } from "./http"

export const AUTOPILOT_PATH = /^\/api\/tasks\/([a-z0-9]+)\/autopilot(?:\/(resume|send-now|skip|history))?$/

export function autopilotUpdateError(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) if (key !== "autoMerge" && key !== "autoFix") return `unknown field '${key}'`
  for (const key of ["autoMerge", "autoFix"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return `${key} must be a boolean, got ${typeName(body[key])}`
  }
  return null
}

/** What a resume releases: a pause, a Stop hold, a merge-failure count, or a finished PR. */
function isHeld(taskId: string): boolean {
  const row = autopilotRow(taskId)
  if (!row) return false
  const checkpoint = checkpointOf(row)
  return row.state === "paused" || Boolean(checkpoint.stopHold || checkpoint.mergeFailures || checkpoint.done)
}

export async function autopilotRoute(req: Request, path: string): Promise<Response> {
  const match = path.match(AUTOPILOT_PATH)!
  const taskId = match[1]!
  if (!getTask(taskId)) return err("Task not found", 404)
  try {
    if (match[2] === "history") return req.method === "GET" ? json<AutopilotHistoryResponse>({ history: autopilotHistory(taskId) }) : err("Method not allowed", 405)
    if (match[2]) {
      if (req.method !== "POST") return err("Method not allowed", 405)
      const verb = match[2] as "resume" | "send-now" | "skip"
      const held = verb === "resume" && isHeld(taskId)
      const status = { resume: resumeAutopilot, "send-now": sendPendingFix, skip: skipPendingFix }[verb](taskId)
      // a resume with nothing paused or held only asks for a fresh look; send-now and skip refuse unless a round waits
      if (verb !== "resume" || held) recordAudit(taskId, `autopilot-${verb}`, requestActor(req))
      return json(status)
    }
    if (req.method === "GET") return json(autopilotStatus(taskId))
    if (req.method !== "PUT") return err("Method not allowed", 405)
    const body = await jsonObjectBody(req)
    if (body instanceof Response) return body
    const invalid = autopilotUpdateError(body)
    if (invalid) return err(invalid, 400)
    const before = autopilotStatus(taskId)
    const after = setAutopilot(taskId, body as AutopilotUpdate)
    const moved = autopilotSwitchDetail(before, after)
    if (moved) recordAudit(taskId, "autopilot", requestActor(req), moved)
    return json(after)
  } catch (error) {
    if (error instanceof AutopilotError) return err(error.message, error.status)
    throw error
  }
}
