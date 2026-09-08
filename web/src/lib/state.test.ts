import { describe, expect, it } from "vitest"

import { duration, elapsed, stateWord } from "./state"
import type { ApiTask } from "./types"

const START = "2026-08-27T12:00:00.000Z"
const after = (seconds: number): number => new Date(START).getTime() + seconds * 1000

describe("elapsed (a turn still running)", () => {
  it("counts seconds under a minute", () => {
    expect(elapsed(START, after(0))).toBe("0s")
    expect(elapsed(START, after(41))).toBe("41s")
  })

  it("switches to minutes with zero-padded seconds, so the width never jumps", () => {
    expect(elapsed(START, after(60))).toBe("1m 00s")
    expect(elapsed(START, after(161))).toBe("2m 41s")
  })

  it("drops seconds past an hour — a turn that long does not need them", () => {
    expect(elapsed(START, after(3600))).toBe("1h 00m")
    expect(elapsed(START, after(3600 + 125))).toBe("1h 02m")
  })

  it("returns null rather than a negative count when the clock disagrees", () => {
    // a daemon a few seconds ahead of the browser must not render "-3s"
    expect(elapsed(START, after(-3))).toBeNull()
  })

  it("returns null for an unparseable timestamp", () => {
    expect(elapsed("not a date", Date.now())).toBeNull()
  })
})

describe("duration (a turn that finished)", () => {
  it("is null while the turn is still running — that is elapsed()'s job", () => {
    expect(duration(START, null)).toBeNull()
  })

  it("formats a finished turn the same way elapsed formats a live one", () => {
    const end = new Date(after(161)).toISOString()
    expect(duration(START, end)).toBe("2m 41s")
    expect(duration(START, end)).toBe(elapsed(START, after(161)))
  })

  it("accepts numeric harness timestamps for subagent lifecycles", () => {
    expect(duration(after(0), after(7))).toBe("7s")
  })
})

describe("stateWord (the honest failure word, Theme B)", () => {
  // only the fields the rule reads need to be real
  const task = (over: Partial<ApiTask>): ApiTask =>
    ({ state: "failed", latest_turn_exit_code: null, latest_turn_has_result: false, ...over }) as ApiTask

  it("failed + a result + a nonzero exit reads 'Exited N' — the work landed", () => {
    expect(stateWord(task({ latest_turn_has_result: true, latest_turn_exit_code: 1 }))).toBe("Exited 1")
    expect(stateWord(task({ latest_turn_has_result: true, latest_turn_exit_code: 143 }))).toBe("Exited 143")
  })

  it("a result-less failure stays Failed — it really did not deliver", () => {
    expect(stateWord(task({ latest_turn_exit_code: 1 }))).toBe("Failed")
    expect(stateWord(task({ latest_turn_has_result: true }))).toBe("Failed") // exit unknown
    expect(stateWord(task({}))).toBe("Failed")
    // a pre-Theme-B row simply lacks the fields
    expect(stateWord({ state: "failed" } as ApiTask)).toBe("Failed")
  })

  it("every other state keeps its own word, exit code or not", () => {
    expect(stateWord(task({ state: "done", latest_turn_has_result: true, latest_turn_exit_code: 0 }))).toBe("Done")
    expect(stateWord(task({ state: "running" }))).toBe("Running")
    expect(stateWord(task({ state: "needs-input" }))).toBe("Needs input")
  })
})
