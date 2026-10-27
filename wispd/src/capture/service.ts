/**
 * `POST /api/tasks/:id/capture` without the HTTP: who may capture, how many at
 * once, what is recorded whatever happens, and where the image goes. The
 * browser work is capture.ts; this is the bookkeeping around it.
 */
import type { CaptureBody, CaptureResponse } from "../../../shared/api/captures"
import { outputImageUrl } from "../../../shared/api/outputs"
import { repoConfigFor, type WispConfig } from "../config"
import { OutputError, publishOutputImage, publishingStep } from "../outputs"
import { getTask, runningTurn } from "../store"
import { portRange } from "../turn-input"
import type { Task } from "../types"
import { reviewOfTask, reviewTokenFor } from "../verify/reviews"
import { capturePage, CaptureFailure, MAX_VIEWPORT, SCRIPT_MAX_BYTES, VIEWPORTS, type CaptureRequest, type CaptureShot, type Viewport } from "./capture"
import { findChrome } from "./chrome"
import { CaptureUrlError, isLoopbackHost, parseCaptureUrl, portOf, sanitizeUrl } from "./policy"
import { servedFrom, type ServedFrom } from "./served-from"
import { captureView, recordCapture, type NewCapture } from "./store"

/** At most this many browsers at once across the daemon; one per task. */
export const CAPTURE_SLOTS = 2
export const QUEUE_WAIT_MS = 60_000
const WAIT_MS_MAX = 10_000

export class CaptureRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** What the service needs from the world; tests replace the browser. */
export interface CaptureDeps {
  cfg: WispConfig
  shoot?: (request: CaptureRequest, context: Parameters<typeof capturePage>[1]) => Promise<CaptureShot>
  chrome?: () => ReturnType<typeof findChrome>
  served?: (port: number, worktree: string | null) => Promise<ServedFrom>
}

let busy = 0
const waiting: (() => void)[] = []
const busyTasks = new Set<string>()

/** A browser slot, waited for up to QUEUE_WAIT_MS; false when none came. */
async function acquire(): Promise<boolean> {
  if (busy < CAPTURE_SLOTS) {
    busy++
    return true
  }
  return new Promise((resolve) => {
    const wake = () => { clearTimeout(timer); busy++; resolve(true) }
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(wake), 1); resolve(false) }, QUEUE_WAIT_MS)
    waiting.push(wake)
  })
}

function release(): void {
  busy--
  waiting.shift()?.()
}

/** The body, checked; a wrong one is the caller's mistake (400), never a recorded attempt. */
export function captureRequestOf(body: CaptureBody): { request: CaptureRequest; area: string | null; name: string | null; allowPorts: number[] } {
  if (typeof body.url !== "string") throw new CaptureRefusal("url is required", 400)
  let url: URL
  try {
    url = parseCaptureUrl(body.url)
  } catch (error) {
    if (error instanceof CaptureUrlError) throw new CaptureRefusal(error.message, 400)
    throw error
  }
  const text = (key: keyof CaptureBody, max: number): string | null => {
    const value = body[key]
    if (value === undefined || value === null || value === "") return null
    if (typeof value !== "string" || value.length > max) throw new CaptureRefusal(`${key} must be text of at most ${max} characters`, 400)
    return value
  }
  const script = text("script", SCRIPT_MAX_BYTES)
  const waitMs = body.waitMs ?? 0
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > WAIT_MS_MAX) throw new CaptureRefusal(`waitMs must be 0 to ${WAIT_MS_MAX}`, 400)
  const allowPorts = body.allowPorts ?? []
  if (!Array.isArray(allowPorts) || allowPorts.length > 10 || allowPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new CaptureRefusal("allowPorts must be up to 10 port numbers", 400)
  }
  for (const key of ["dark", "fullPage"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw new CaptureRefusal(`${key} must be true or false`, 400)
  }
  const area = text("area", 64)
  if (area !== null && !/^[a-z0-9][a-z0-9-]*$/.test(area)) throw new CaptureRefusal("area must be a recipe area name (lowercase letters, digits, dashes)", 400)
  return {
    request: {
      url, viewport: viewportOf(body.viewport), dark: body.dark === true, selector: text("selector", 500), fullPage: body.fullPage === true,
      waitFor: text("waitFor", 500), waitMs, script,
    },
    area, name: text("name", 120), allowPorts,
  }
}

export function viewportOf(raw: unknown): Viewport {
  if (raw === undefined || raw === null || raw === "" || raw === "desktop") return VIEWPORTS.desktop
  if (raw === "mobile") return VIEWPORTS.mobile
  const match = typeof raw === "string" ? raw.match(/^(\d{2,4})x(\d{2,4})$/) : null
  const width = Number(match?.[1]), height = Number(match?.[2])
  if (!match || width < 200 || height < 200 || width > MAX_VIEWPORT || height > MAX_VIEWPORT) {
    throw new CaptureRefusal(`viewport must be desktop, mobile, or <width>x<height> from 200 to ${MAX_VIEWPORT}`, 400)
  }
  return { width, height, mobile: false }
}

/** Who may capture into this task now: a running turn, and from a reviewer only with its live review token. */
function admit(task: Task, token: string | undefined): { turn: { id: number; n: number }; reviewId: string | null } {
  if (task.archived) throw new CaptureRefusal("archived tasks cannot capture", 409)
  const turn = runningTurn(task.id)
  if (!turn) throw new CaptureRefusal("a capture belongs to a running turn: run `wisp capture` from inside the task's turn", 409)
  if (task.verify_role !== "reviewer") return { turn, reviewId: null }
  const live = reviewTokenFor(task.id)
  if (!live || token !== live) throw new CaptureRefusal("a reviewer captures with its own review token (WISP_REVIEW_TOKEN), while its review runs", 403)
  return { turn, reviewId: reviewOfTask(task.id)?.id ?? null }
}

/** Still the same running turn, and for a reviewer still its live review: checked again after every wait. */
function stillAdmitted(task: Task, turnId: number, reviewId: string | null, token: string | undefined): boolean {
  if (runningTurn(task.id)?.id !== turnId) return false
  return reviewId === null || (reviewTokenFor(task.id) === token && token !== undefined)
}

/** Where the page now on screen came from: a loopback page's listener, and never the worktree for a page off this machine. */
async function provenanceOf(finalUrl: string, worktree: string | null, served: NonNullable<CaptureDeps["served"]>): Promise<ServedFrom> {
  let url: URL
  try {
    url = new URL(finalUrl)
  } catch {
    return "unknown"
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) return "elsewhere"
  return served(portOf(url), worktree)
}

export async function captureForTask(taskId: string, body: CaptureBody, deps: CaptureDeps): Promise<CaptureResponse & { failed?: boolean }> {
  const task = getTask(taskId)
  if (!task) throw new CaptureRefusal("Task not found", 404)
  const { turn, reviewId } = admit(task, body.token)
  const { request, area, name, allowPorts } = captureRequestOf(body)
  const base: NewCapture = {
    task_id: task.id, turn: turn.n, image_id: null, review_id: reviewId, area, status: "failed", reason: null, message: null,
    requested_url: sanitizeUrl(request.url), final_url: null, http_status: null,
    viewport: request.viewport === VIEWPORTS.desktop ? "desktop" : request.viewport === VIEWPORTS.mobile ? "mobile" : `${request.viewport.width}x${request.viewport.height}`,
    dpr: null, width: null, height: null, media_type: null, full_page: request.fullPage ? 1 : 0, clipped: 0,
    selector_used: request.selector ? 1 : 0, script_used: request.script ? 1 : 0, settled: 1, served_from: null, errors_json: null, blocked_json: null,
  }
  const failed = (reason: CaptureFailure["reason"], message: string) => {
    const row = recordCapture({ ...base, reason, message })
    return { capture: captureView(row), imageUrl: null, failed: true }
  }
  const chrome = (deps.chrome ?? (() => findChrome(deps.cfg.chromePath)))()
  if (!("path" in chrome)) return failed("no-chrome", chrome.reason)
  // the task's own second capture is the caller's doing: refused, never recorded as the machine being busy
  if (busyTasks.has(task.id)) throw new CaptureRefusal("this task already has a capture running: wait for it, then capture again", 409)
  busyTasks.add(task.id)
  try {
    if (!(await acquire())) return failed("busy", `every capture slot stayed busy for ${QUEUE_WAIT_MS / 1000}s: try again in a moment`)
    try {
      if (!stillAdmitted(task, turn.id, reviewId, body.token)) return failed("cancelled", "the turn or the review ended while the capture waited for a browser")
      const admitted = () => stillAdmitted(task, turn.id, reviewId, body.token)
      return await shootAndStore(task, turn, request, base, { chromePath: chrome.path, allowPorts, name, admitted }, deps)
    } catch (error) {
      if (error instanceof CaptureFailure) return failed(error.reason, error.message)
      if (error instanceof OutputError) return failed("storage", `the shot could not be stored: ${error.message}`)
      throw error
    } finally {
      release()
    }
  } finally {
    busyTasks.delete(task.id)
  }
}

async function shootAndStore(
  task: Task, turn: { id: number; n: number }, request: CaptureRequest, base: NewCapture,
  options: { chromePath: string; allowPorts: number[]; name: string | null; admitted: () => boolean }, deps: CaptureDeps,
): Promise<CaptureResponse> {
  // the capture ends with its turn: a stopped or finished turn's capture is moot
  const controller = new AbortController()
  const watch = setInterval(() => { if (runningTurn(task.id)?.id !== turn.id) controller.abort() }, 1_000)
  try {
    const range = portRange(task)
    const ports = [...options.allowPorts, ...(range ? Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i) : [])]
    const shot = await (deps.shoot ?? capturePage)(request, {
      chromePath: options.chromePath, daemonPort: deps.cfg.port, ports, publicAllowed: repoConfigFor(deps.cfg, task.repo_path)?.capturePublic !== false,
      signal: controller.signal,
    })
    const served = await provenanceOf(shot.finalUrl, task.worktree_path, deps.served ?? servedFrom)
    // checked once more right before the image lands: a turn or review that ended meanwhile gets nothing
    if (!options.admitted()) throw new CaptureFailure("cancelled", "the turn or the review ended before the shot could be stored")
    const extension = shot.mediaType === "image/png" ? "png" : "jpg"
    const image = publishOutputImage(turn.id, shot.bytes, `${options.name ?? `capture-${base.viewport}`}.${extension}`, "published", publishingStep(turn.id, "capture"))
    const row = recordCapture({
      ...base, status: "ok", image_id: image.id, final_url: sanitizeUrl(shot.finalUrl), http_status: shot.status, dpr: shot.dpr,
      width: shot.width, height: shot.height, media_type: shot.mediaType, clipped: shot.clipped ? 1 : 0, settled: shot.settled ? 1 : 0,
      served_from: served, errors_json: JSON.stringify(shot.errors), blocked_json: JSON.stringify(shot.blocked),
    })
    return { capture: captureView(row), imageUrl: outputImageUrl(task.id, turn.n, image.id) }
  } finally {
    clearInterval(watch)
  }
}
