import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fromNow } from "@/lib/time"

import { clock, nextWordingChange } from "./useTick"

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

describe("when a relative reading can next change", () => {
  const at = Date.parse("2026-03-01T08:15:42.250Z")
  const iso = new Date(at).toISOString()
  const ages = [
    ...Array.from({ length: 7_200 }, (_, second) => second * 1_000),
    ...Array.from({ length: 4_320 }, (_, minute) => minute * 60_000 + 17_000),
    ...Array.from({ length: 9_600 }, (_, hour) => hour * 3_600_000 + 1_234_000),
  ]

  it("is never after the reading actually changes", () => {
    for (const age of ages) {
      const now = at + age
      const next = nextWordingChange(at, now)
      expect(next).toBeGreaterThan(now)
      expect(fromNow(iso, next - 1)).toBe(fromNow(iso, now))
    }
  })

  it("is a minute out at most while the bubble is young, and an hour once it is not", () => {
    expect(nextWordingChange(at, at + 10_000)).toBe(at + 60_000)
    expect(nextWordingChange(at, at + 61_000)).toBe(at + 120_000)
    expect(nextWordingChange(at, at + 3 * 3_600_000 + 5)).toBe(at + 4 * 3_600_000)
  })
})
