import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clock } from "./useTick"

describe("a shared clock", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads now for a reader that joins between ticks, and moves the readers it has with it", () => {
    const minutes = clock(60_000)
    const first = vi.fn()
    const stopFirst = minutes.subscribe(first)
    const start = minutes.now()

    vi.advanceTimersByTime(59_000)
    const stopSecond = minutes.subscribe(() => {})
    expect(minutes.now()).toBe(start + 59_000)
    // one instant for every reader: the first one hears that it moved
    expect(first).toHaveBeenCalledOnce()

    stopFirst()
    stopSecond()
  })

  it("still ticks once a period", () => {
    const minutes = clock(60_000)
    const reader = vi.fn()
    const stop = minutes.subscribe(reader)
    vi.advanceTimersByTime(120_000)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(minutes.now()).toBe(Date.now())
    stop()
  })
})
