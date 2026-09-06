import { SSE_CLOSED, type SseFactory, type SseLike } from "@/lib/sse"
import type { DaemonTransport } from "@/lib/transport"
import type { ActivityLogStreamFrames, Turn } from "@/lib/types"
import {
  initialStreamState,
  streamReducer,
  type ActivityItem,
  type StreamBlock,
  type StreamState,
  type ToolActivityItem,
} from "@/stream/reducer"

export interface TurnActivity {
  /** Every prose, tool, thought and subagent in harness order. */
  items: ActivityItem[]
  /** Parent-agent prose only, retained for the result-recovery path. */
  text: string
}

const EMPTY: TurnActivity = { items: [], text: "" }

/** Keep growing live transcripts cheap until a settled conclusion needs prose. */
function turnActivity(items: ActivityItem[]): TurnActivity {
  let text: string | undefined
  return {
    items,
    get text() {
      text ??= items
        .filter((item) => item.kind === "text")
        .map((item) => item.text)
        .join("\n")
      return text
    },
  }
}

/** Every tool step, recursively, in display order. */
export function stepsOf(activity: TurnActivity): ToolActivityItem[] {
  const out: ToolActivityItem[] = []
  const visit = (items: ActivityItem[]) => {
    for (const item of items) {
      if (item.kind === "tool") out.push(item)
      else if (item.kind === "subagent") visit(item.items)
    }
  }
  visit(activity.items)
  return out
}

/**
 * One segment of a turn's timeline: the activity that ran, then the message
 * that arrived after it. `messageId` is null on the trailing segment.
 *
 * The anchor comes from the turn's log, where the daemon wrote it at native
 * admission, so this is the harness's own order rather than the browser's
 * arrival order — a reload, a second tab and a settled turn's refetch all
 * rebuild the same split.
 */
export interface TimelineSegment {
  items: ActivityItem[]
  messageId: string | null
}

export function splitByMessage(items: ActivityItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  let pending: ActivityItem[] = []
  for (const item of items) {
    if (item.kind === "message") {
      segments.push({ items: pending, messageId: item.id })
      pending = []
    } else {
      pending.push(item)
    }
  }
  segments.push({ items: pending, messageId: null })
  return segments
}

/** The message ids this turn's timeline can place; everything else is unanchored. */
export function anchoredMessageIds(items: ActivityItem[]): Set<string> {
  return new Set(items.filter((item) => item.kind === "message").map((item) => item.id))
}

/** Split the live stream's blocks by turn. */
export function activityByTurn(blocks: StreamBlock[]): Record<number, TurnActivity> {
  const out: Record<number, TurnActivity> = {}
  let turn = 0
  for (const block of blocks) {
    if (block.kind === "separator") {
      turn = block.end === null ? block.turn : 0
      if (turn !== 0) out[turn] ??= { items: [], text: "" }
      continue
    }
    if (turn === 0 || block.kind !== "activity") continue
    out[turn] = turnActivity(block.items)
  }
  return out
}

/**
 * Activity for a settled turn. It uses the same canonical stream as live
 * turns and waits for `turn-end`, so histories larger than the first-read
 * budget are complete rather than silently presented as a tail.
 */
export function fetchTurnActivity(
  taskId: string,
  n: number,
  {
    transport,
    factory,
    timeoutMs = 30_000,
    signal,
  }: {
    transport?: Pick<DaemonTransport, "openEventStream">
    factory?: SseFactory
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<TurnActivity> {
  return new Promise((resolve, reject) => {
    let state: StreamState = initialStreamState
    let settled = false
    const path = `/api/tasks/${taskId}/log/stream?format=activity&turn=${n}`
    const source: SseLike = factory
      ? factory(path)
      : transport
        ? (transport.openEventStream(path) as unknown as SseLike)
        : (() => {
            throw new Error("activity stream requires a daemon transport")
          })()

    const cleanup = () => {
      clearTimeout(timer)
      source.close()
      signal?.removeEventListener("abort", abort)
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(activityByTurn(state.blocks)[n] ?? EMPTY)
    }

    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException("Activity request aborted", "AbortError"))
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }

    const timer = setTimeout(() => fail(`Timed out loading activity for turn ${n}`), timeoutMs)
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })

    source.addEventListener("backlog", (ev) => {
      const d = JSON.parse(ev.data) as ActivityLogStreamFrames["backlog"]
      if (d.turn !== n) return
      state = streamReducer(state, {
        type: "backlog",
        turn: d.turn,
        prompt: d.prompt,
        activity: d.activity,
      })
    })
    source.addEventListener("append", (ev) => {
      const d = JSON.parse(ev.data) as ActivityLogStreamFrames["append"]
      if (d.turn !== n) return
      state = streamReducer(state, { type: "append", turn: d.turn, activity: d.activity })
    })
    source.addEventListener("turn-end", (ev) => {
      const d = JSON.parse(ev.data) as ActivityLogStreamFrames["turn-end"]
      if (d.turn === n) finish()
    })
    source.onerror = () => {
      if (source.readyState === SSE_CLOSED) fail(`Activity stream closed before turn ${n} completed`)
    }
  })
}

/**
 * A turn's conclusion renders only when it ADDS something. The parse layer
 * guarantees turn.result is the turn's concluding prose (src/adapters/
 * parse.ts: derived from the assistant events, not the harness's terminal-
 * event text — cursor's result event repeats the WHOLE turn's prose, which
 * is what made the conclusion a second copy of everything). The timeline
 * truncates prose lines (300 chars), so three cases:
 *
 *   timeline not on screen        settled, collapsed turn → the block is the
 *                                 only rendering of the final word
 *   timeline shows it IN FULL     short final message, untruncated → the
 *                                 block would be a verbatim repeat: withhold
 *   timeline shows a PREFIX       long final message truncated at 300, or a
 *                                 budget-truncated/partially-delivered log →
 *                                 the block carries the full text: keep
 *
 * Containment is the proof, and it subsumes completeness: a timeline that
 * never reached the turn's end cannot contain the concluding prose, so no
 * separate "did the stream finish" signal is needed.
 */
export function conclusionText(turn: Pick<Turn, "status" | "result">, timelineText?: string): string | null {
  if (turn.status === "running") return null
  const result = turn.result
  if (!result) return null
  if (timelineText !== undefined && timelineText.includes(result.trim())) return null
  return result
}

/** What one activity row shows. */
export interface StepSummary {
  verb: string
  arg: string
  note: string | null
}

/** The compact row summary for one canonical tool event. */
export function summarizeStep(step: ToolActivityItem): StepSummary {
  return {
    verb: step.name || "Run",
    arg: bestField(step.input),
    note: shortResult(step),
  }
}

const FIELDS = ["file_path", "path", "notebook_path", "command", "pattern", "query", "url", "description"]

function bestField(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return value == null ? "" : String(value)
  const input = value as Record<string, unknown>
  for (const key of FIELDS) {
    const field = input[key]
    if (typeof field === "string" && field) return field
  }
  const first = Object.values(input).find((field) => typeof field === "string" && field)
  if (typeof first === "string") return first
  return Object.keys(input).length ? safeJson(input) : ""
}

const NOTE_MAX = 24

function shortResult(step: ToolActivityItem): string | null {
  const value = step.error ?? step.output
  if (!value) return null
  const oneLine = value.replaceAll("\n", " ").trim()
  return oneLine.length <= NOTE_MAX ? oneLine : null
}

export function toolDetails(step: ToolActivityItem): string {
  const parts: string[] = []
  if (step.input !== null && step.input !== undefined) parts.push(safeJson(step.input))
  if (step.output) parts.push(step.output)
  if (step.error) parts.push(`Error: ${step.error}`)
  return parts.join("\n")
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
