import type { CaptureBody } from "../../../shared/api/captures"
import { CaptureRefusal, captureForTask } from "../capture/service"
import { captureView, capturesOfTask } from "../capture/store"
import type { WispConfig } from "../config"
import { OutputError } from "../outputs"
import { getTask } from "../store"
import { assertTaskNotStopping, InterruptConflict } from "../turn-interrupt"
import { err, json, jsonObjectBody } from "./http"

export const CAPTURE_PATH = /^\/api\/tasks\/([a-z0-9]+)\/captures?$/

/**
 * POST /api/tasks/:id/capture: Wisp opens a page on this machine's loopback in
 * its own headless Chrome and stores the shot in the running turn. A failed
 * attempt is recorded too and answered 422 with its reason, so "no Chrome
 * here" is Wisp's fact rather than the agent's word.
 * GET /api/tasks/:id/captures: the task's attempts, newest first.
 */
export async function captureRoute(req: Request, path: string, cfg: WispConfig): Promise<Response> {
  const taskId = path.match(CAPTURE_PATH)![1]!
  if (!getTask(taskId)) return err("Task not found", 404)
  if (req.method === "GET" && path.endsWith("/captures")) return json({ captures: capturesOfTask(taskId).map(captureView) })
  if (req.method !== "POST" || !path.endsWith("/capture")) return err("Method not allowed", 405)
  const body = await jsonObjectBody(req)
  if (body instanceof Response) return body
  try {
    assertTaskNotStopping(taskId)
    const result = await captureForTask(taskId, body as unknown as CaptureBody, { cfg })
    const { failed, ...response } = result
    return failed ? json({ error: response.capture.message, ...response }, 422) : json(response, 201)
  } catch (error) {
    if (error instanceof CaptureRefusal || error instanceof OutputError) return err(error.message, error.status)
    if (error instanceof InterruptConflict) return err(error.message, 409)
    throw error
  }
}
