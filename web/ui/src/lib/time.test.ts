import { describe, expect, it } from "vitest"

import { fromNow, utcIso } from "./time"

const NOW = Date.parse("2026-09-06T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("fromNow", () => {
  it("speaks Wisp's terse relative vocabulary", () => {
    expect(fromNow(ago(0), NOW)).toBe("just now")
    expect(fromNow(ago(59 * SECOND), NOW)).toBe("just now")
    expect(fromNow(ago(MINUTE), NOW)).toBe("1 min ago")
    expect(fromNow(ago(5 * MINUTE), NOW)).toBe("5 min ago")
    expect(fromNow(ago(59 * MINUTE), NOW)).toBe("59 min ago")
    expect(fromNow(ago(HOUR), NOW)).toBe("1h ago")
    expect(fromNow(ago(3 * HOUR), NOW)).toBe("3h ago")
    expect(fromNow(ago(23 * HOUR), NOW)).toBe("23h ago")
    expect(fromNow(ago(DAY), NOW)).toBe("1d ago")
    expect(fromNow(ago(2 * DAY), NOW)).toBe("2d ago")
    expect(fromNow(ago(31 * DAY), NOW)).toBe("1mo ago")
    expect(fromNow(ago(400 * DAY), NOW)).toBe("1y ago")
  })

  it("floors rather than rounding, so a unit is never overstated", () => {
    expect(fromNow(ago(90 * MINUTE), NOW)).toBe("1h ago")
    expect(fromNow(ago(47 * HOUR), NOW)).toBe("1d ago")
  })

  it("does not read a fresh instant back as 'just now ago'", () => {
    expect(fromNow(ago(-2 * SECOND), NOW)).toBe("just now")
    expect(fromNow(ago(-5 * MINUTE), NOW)).toBe("in 5 min")
  })

  it("says nothing for an instant it cannot parse", () => {
    expect(fromNow("not a date", NOW)).toBe("")
  })
})

describe("utcIso", () => {
  it("says the instant exactly, in UTC, without milliseconds", () => {
    expect(utcIso("2026-09-06T12:34:56.789Z")).toBe("2026-09-06T12:34:56Z")
    expect(utcIso("2026-09-06T12:34:56+07:00")).toBe("2026-09-06T05:34:56Z")
  })

  it("says nothing for an instant it cannot parse", () => {
    expect(utcIso("not a date")).toBe("")
  })
})
