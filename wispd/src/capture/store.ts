/**
 * The record of every `wisp capture` attempt: what Wisp saw, kept beside the
 * turn's output manifest. The image itself is an ordinary published output.
 */
import type { CaptureFailureReason, CaptureRecord, CaptureServedFrom } from "../../../shared/api/captures"
import { randomId } from "../store"
import { db } from "../store-database"

export interface CaptureRow {
  id: string
  task_id: string
  turn: number
  image_id: string | null
  review_id: string | null
  area: string | null
  status: "ok" | "failed"
  reason: CaptureFailureReason | null
  message: string | null
  requested_url: string
  final_url: string | null
  http_status: number | null
  viewport: string
  dpr: number | null
  width: number | null
  height: number | null
  media_type: string | null
  full_page: number
  clipped: number
  selector_used: number
  script_used: number
  settled: number
  served_from: CaptureServedFrom | null
  errors_json: string | null
  blocked_json: string | null
  created_at: string
}

export type NewCapture = Omit<CaptureRow, "id" | "created_at">

export function recordCapture(capture: NewCapture, now = new Date()): CaptureRow {
  const id = randomId("cap", 10)
  const row: CaptureRow = { ...capture, id, created_at: now.toISOString() }
  const columns = Object.keys(row)
  db.run(`INSERT INTO captures(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, Object.values(row) as (string | number | null)[])
  return row
}

export function getCapture(id: string): CaptureRow | null {
  return db.query("SELECT * FROM captures WHERE id = ?").get(id) as CaptureRow | null
}

/** Every attempt one review made, oldest first. */
export function capturesOfReview(reviewId: string): CaptureRow[] {
  return db.query("SELECT * FROM captures WHERE review_id = ? ORDER BY created_at, rowid").all(reviewId) as CaptureRow[]
}

/** A task's attempts, newest first. */
export function capturesOfTask(taskId: string, limit = 50): CaptureRow[] {
  return db.query("SELECT * FROM captures WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(taskId, limit) as CaptureRow[]
}

const list = (json: string | null): string[] => {
  try {
    const value: unknown = JSON.parse(json ?? "[]")
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

export function captureView(row: CaptureRow): CaptureRecord {
  return {
    id: row.id, taskId: row.task_id, turn: row.turn, status: row.status, reason: row.reason, message: row.message,
    imageId: row.image_id, mediaType: row.media_type, area: row.area, url: row.requested_url, finalUrl: row.final_url,
    httpStatus: row.http_status, viewport: row.viewport, width: row.width, height: row.height,
    fullPage: row.full_page === 1, clipped: row.clipped === 1, selectorUsed: row.selector_used === 1, scriptUsed: row.script_used === 1,
    settled: row.settled === 1, servedFrom: row.served_from, errors: list(row.errors_json), blocked: list(row.blocked_json), createdAt: row.created_at,
  }
}
