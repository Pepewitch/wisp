/** `wisp capture`: a screenshot Wisp itself took of an app on this machine's loopback. */

/** Why a capture attempt failed, as Wisp recorded it. */
export type CaptureFailureReason =
  | "no-chrome" | "launch-failed" | "unreachable" | "http-error" | "timeout" | "script-error" | "busy" | "cancelled" | "no-element" | "browser-error" | "too-large" | "storage"

/** Where the captured page was served from: the capturing task's own worktree, another process, or not knowable. */
export type CaptureServedFrom = "worktree" | "elsewhere" | "unknown"

/** POST /api/tasks/:id/capture */
export interface CaptureBody {
  url: string
  /** the recipe area this shot shows (auto-review's evidence rule counts it there) */
  area?: string
  name?: string
  /** "desktop" (default), "mobile", or "<width>x<height>" */
  viewport?: string
  dark?: boolean
  selector?: string
  fullPage?: boolean
  waitFor?: string
  waitMs?: number
  script?: string
  allowPorts?: number[]
  /** a reviewer's WISP_REVIEW_TOKEN; required from an auto-review reviewer's task */
  token?: string
}

/** One attempt as Wisp keeps it. URLs are sanitized: no user info, no query values. */
export interface CaptureRecord {
  id: string
  taskId: string
  turn: number
  status: "ok" | "failed"
  reason: CaptureFailureReason | null
  message: string | null
  imageId: string | null
  mediaType: string | null
  area: string | null
  url: string
  finalUrl: string | null
  httpStatus: number | null
  viewport: string
  width: number | null
  height: number | null
  fullPage: boolean
  clipped: boolean
  selectorUsed: boolean
  scriptUsed: boolean
  /** the network went quiet before the shot (SSE and HMR pages never do; that is not a failure) */
  settled: boolean
  servedFrom: CaptureServedFrom | null
  errors: string[]
  blocked: string[]
  createdAt: string
}

export interface CaptureResponse {
  capture: CaptureRecord
  /** the stored image, for an ok capture: GET it with the output route */
  imageUrl: string | null
}
