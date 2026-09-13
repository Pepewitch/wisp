import { describe, expect, it } from "vitest"

import { createLogStreamDecoder, LogStreamProtocolError } from "./log-stream-protocol"

const activity = {
  kind: "tool",
  id: "tool-1",
  parentId: null,
  phase: "started",
  name: "Read",
  input: { file_path: "src/app.ts" },
} as const

function decoders() {
  const decoder = createLogStreamDecoder()
  return [
    ["hello", "hello", decoder.hello],
    ["raw backlog", "backlog", decoder.textBacklog],
    ["raw append", "append", decoder.textAppend],
    ["activity backlog", "backlog", decoder.activityBacklog],
    ["activity append", "append", decoder.activityAppend],
    ["turn-end", "turn-end", decoder.turnEnd],
  ] as const
}

describe("log stream protocol decoder", () => {
  it("accepts every named frame shape", () => {
    const decoder = createLogStreamDecoder()
    expect(decoder.hello('{"version":"0.5.7"}')).toEqual({ version: "0.5.7" })
    expect(decoder.textBacklog('{"turn":1,"prompt":"go","text":"ready"}')).toEqual({
      turn: 1,
      prompt: "go",
      text: "ready",
    })
    expect(decoder.textAppend('{"turn":1,"text":"next"}')).toEqual({ turn: 1, text: "next" })
    expect(
      decoder.activityBacklog(JSON.stringify({ turn: 1, prompt: "go", activity: [activity] })),
    ).toEqual({ turn: 1, prompt: "go", activity: [activity] })
    expect(decoder.activityAppend(JSON.stringify({ turn: 1, activity: [activity] }))).toEqual({
      turn: 1,
      activity: [activity],
    })
    expect(decoder.turnEnd('{"turn":1,"status":"done"}')).toEqual({ turn: 1, status: "done" })
  })

  it.each(decoders())("rejects malformed JSON for %s", (_label, event, decode) => {
    expect(() => decode("{")).toThrow(LogStreamProtocolError)
    expect(() => decode("{")).toThrow(`"${event}"`)
  })

  it.each(decoders())("rejects the wrong runtime shape for %s", (_label, _event, decode) => {
    expect(() => decode("[]")).toThrow(LogStreamProtocolError)
  })

  it("validates nested activity events instead of trusting the outer array", () => {
    const decoder = createLogStreamDecoder()
    expect(() =>
      decoder.activityAppend(
        JSON.stringify({
          turn: 1,
          activity: [{ kind: "tool", id: "tool-1", parentId: null, phase: "invented", name: "Read" }],
        }),
      ),
    ).toThrow("expected { turn, activity[] }")
  })

  it("names the event and handshake version in a protocol error", () => {
    const decoder = createLogStreamDecoder()
    decoder.hello('{"version":"0.5.7-remote"}')
    expect(() => decoder.textAppend('{"turn":1,"text":7}')).toThrow(
      'Log stream protocol error in "append" from daemon 0.5.7-remote',
    )
  })
})
