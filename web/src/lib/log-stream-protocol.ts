import {
  type ActivityEvent,
  type ActivityLogStreamFrames,
  type LogStreamFrames,
} from "./types"
import type { SseLike } from "./sse"

const TURN_STATUSES = new Set(["running", "done", "failed", "interrupted"])
const ACTIVITY_STATUSES = new Set(["running", "completed", "failed", "stopped", "unknown"])

type ProtocolEvent = keyof LogStreamFrames

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string"
}

function optionalTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

function questionPrompt(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.index === "number" &&
    Number.isFinite(value.index) &&
    (value.topic === null || typeof value.topic === "string") &&
    typeof value.question === "string" &&
    typeof value.multiSelect === "boolean" &&
    Array.isArray(value.options) &&
    value.options.every((option) => typeof option === "string")
  )
}

function questionAnswer(value: unknown): boolean {
  return (
    record(value) &&
    typeof value.index === "number" &&
    Number.isFinite(value.index) &&
    typeof value.answer === "string"
  )
}

function questionEvent(value: Record<string, unknown>): boolean {
  return (
    (value.phase === "asked" || value.phase === "answered" || value.phase === "cancelled") &&
    (value.reason === undefined || value.reason === "superseded" || value.reason === "stopped") &&
    (value.questions === undefined ||
      (Array.isArray(value.questions) && value.questions.every(questionPrompt))) &&
    (value.answers === undefined ||
      (Array.isArray(value.answers) && value.answers.every(questionAnswer)))
  )
}

function activityEvent(value: unknown): value is ActivityEvent {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    !optionalTimestamp(value.timestamp)
  ) {
    return false
  }
  switch (value.kind) {
    case "text":
    case "message":
      return typeof value.text === "string"
    case "thinking":
      return value.text === null || typeof value.text === "string"
    case "tool":
      return (
        (value.phase === "started" || value.phase === "completed") &&
        typeof value.name === "string" &&
        optionalNullableString(value.output) &&
        optionalNullableString(value.error)
      )
    case "subagent":
      return (
        (value.phase === "started" || value.phase === "updated" || value.phase === "completed") &&
        typeof value.status === "string" &&
        ACTIVITY_STATUSES.has(value.status) &&
        optionalNullableString(value.agentId) &&
        optionalNullableString(value.title) &&
        optionalNullableString(value.agentType) &&
        optionalNullableString(value.model) &&
        optionalNullableString(value.effort) &&
        optionalNullableString(value.prompt) &&
        optionalNullableString(value.result) &&
        optionalNullableString(value.error) &&
        (value.durationMs === undefined ||
          value.durationMs === null ||
          (typeof value.durationMs === "number" && Number.isFinite(value.durationMs))) &&
        (value.background === undefined || typeof value.background === "boolean")
      )
    case "question":
      return questionEvent(value)
    default:
      return false
  }
}

function helloFrame(value: unknown): value is LogStreamFrames["hello"] {
  return record(value) && typeof value.version === "string" && value.version.length > 0
}

function textBacklogFrame(value: unknown): value is LogStreamFrames["backlog"] {
  return (
    record(value) &&
    positiveInteger(value.turn) &&
    typeof value.prompt === "string" &&
    typeof value.text === "string"
  )
}

function textAppendFrame(value: unknown): value is LogStreamFrames["append"] {
  return record(value) && positiveInteger(value.turn) && typeof value.text === "string"
}

function activityBacklogFrame(value: unknown): value is ActivityLogStreamFrames["backlog"] {
  return (
    record(value) &&
    positiveInteger(value.turn) &&
    typeof value.prompt === "string" &&
    Array.isArray(value.activity) &&
    value.activity.every(activityEvent)
  )
}

function activityAppendFrame(value: unknown): value is ActivityLogStreamFrames["append"] {
  return (
    record(value) &&
    positiveInteger(value.turn) &&
    Array.isArray(value.activity) &&
    value.activity.every(activityEvent)
  )
}

function turnEndFrame(value: unknown): value is LogStreamFrames["turn-end"] {
  return (
    record(value) &&
    positiveInteger(value.turn) &&
    typeof value.status === "string" &&
    TURN_STATUSES.has(value.status)
  )
}

export class LogStreamProtocolError extends Error {
  constructor(event: ProtocolEvent, daemonVersion: string | null, detail: string) {
    super(
      `Log stream protocol error in "${event}" from daemon ${daemonVersion ?? "unknown version"}: ${detail}`,
    )
    this.name = "LogStreamProtocolError"
  }
}

export function addDecodedLogStreamListener<T>({
  source,
  event,
  active,
  decode,
  consume,
  fail,
}: {
  source: SseLike
  event: ProtocolEvent
  active: () => boolean
  decode: (data: string) => T
  consume: (frame: T) => void
  fail: (error: unknown) => void
}): void {
  source.addEventListener(event, (message) => {
    if (!active()) return
    try {
      consume(decode(message.data))
    } catch (error) {
      fail(error)
    }
  })
}

/**
 * Stateful because the first `hello` frame identifies the daemon for every
 * later protocol error. Frames without `hello` remain accepted for compatibility
 * with older daemons; their errors name the version as unknown.
 */
export function createLogStreamDecoder() {
  let daemonVersion: string | null = null

  function decode<T>(
    event: ProtocolEvent,
    data: string,
    valid: (value: unknown) => value is T,
    expected: string,
  ): T {
    let value: unknown
    try {
      value = JSON.parse(data) as unknown
    } catch {
      throw new LogStreamProtocolError(event, daemonVersion, "invalid JSON")
    }
    if (!valid(value)) {
      throw new LogStreamProtocolError(event, daemonVersion, `expected ${expected}`)
    }
    return value
  }

  return {
    get daemonVersion(): string | null {
      return daemonVersion
    },
    hello(data: string): LogStreamFrames["hello"] {
      const frame = decode("hello", data, helloFrame, "{ version: non-empty string }")
      daemonVersion = frame.version
      return frame
    },
    textBacklog(data: string): LogStreamFrames["backlog"] {
      return decode("backlog", data, textBacklogFrame, "{ turn, prompt, text }")
    },
    textAppend(data: string): LogStreamFrames["append"] {
      return decode("append", data, textAppendFrame, "{ turn, text }")
    },
    activityBacklog(data: string): ActivityLogStreamFrames["backlog"] {
      return decode("backlog", data, activityBacklogFrame, "{ turn, prompt, activity[] }")
    },
    activityAppend(data: string): ActivityLogStreamFrames["append"] {
      return decode("append", data, activityAppendFrame, "{ turn, activity[] }")
    },
    turnEnd(data: string): LogStreamFrames["turn-end"] {
      return decode("turn-end", data, turnEndFrame, "{ turn, status }")
    },
  }
}
