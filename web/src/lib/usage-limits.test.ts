import { describe, expect, it } from "vitest"

import type { HarnessLimitsEntry, LimitWindow } from "./types"
import { limitTone, resetsIn, ringWindow, usageTriggerLabel, windowPools } from "./usage-limits"

const NOW = Date.parse("2026-09-25T02:00:00Z")

const w = (id: string, usedPercent: number, windowMins: number | null, pool: string | null = null): LimitWindow => ({
  id,
  label: id,
  pool,
  usedPercent,
  resetsAt: null,
  windowMins,
})

const entry = (windows: LimitWindow[], status: HarnessLimitsEntry["status"] = "ok"): HarnessLimitsEntry => ({
  name: "claude",
  status,
  limits: status === "ok" ? { plan: null, windows } : null,
  message: null,
  fetchedAt: "2026-09-25T02:00:00Z",
  cached: false,
})

describe("the ring's window", () => {
  it("is the most-used one, and a tie goes to the shorter window", () => {
    expect(ringWindow(entry([w("5h", 33, 300), w("7d", 51, 10_080)]))?.id).toBe("7d")
    expect(ringWindow(entry([w("7d", 20, 10_080), w("5h", 20, 300)]))?.id).toBe("5h")
    expect(ringWindow(entry([w("monthly", 20, null), w("5h", 20, 300)]))?.id).toBe("5h")
  })

  it("is nothing for a harness with no limits to show", () => {
    expect(ringWindow(undefined)).toBeNull()
    expect(ringWindow(entry([], "needs-key"))).toBeNull()
    expect(ringWindow(entry([]))).toBeNull()
  })
})

describe("tone", () => {
  it("warns from 80% and reads as reached at 100%", () => {
    expect(limitTone(79.9)).toBe("normal")
    expect(limitTone(80)).toBe("warn")
    expect(limitTone(100)).toBe("reached")
  })
})

describe("resets", () => {
  it("floors to two units", () => {
    expect(resetsIn(null, NOW)).toBe("")
    expect(resetsIn("not a date", NOW)).toBe("")
    expect(resetsIn("2026-09-25T01:00:00Z", NOW)).toBe("now")
    expect(resetsIn("2026-09-25T02:00:20Z", NOW)).toBe("in 1m")
    expect(resetsIn("2026-09-25T03:29:59Z", NOW)).toBe("in 1h 29m")
    expect(resetsIn("2026-09-28T06:00:00Z", NOW)).toBe("in 3d 4h")
  })
})

describe("pools and labels", () => {
  it("groups by pool in the daemon's order", () => {
    const pools = windowPools([w("a", 1, 300, "standard"), w("b", 1, 300, "core"), w("c", 1, 10_080, "standard")])
    expect(pools.map((p) => [p.pool, p.windows.map((x) => x.id)])).toEqual([
      ["standard", ["a", "c"]],
      ["core", ["b"]],
    ])
  })

  it("names the harness, the window and its pool", () => {
    expect(usageTriggerLabel(null, null)).toBe("Usage limits")
    expect(usageTriggerLabel("claude", w("5h", 27.4, 300))).toBe("Usage limits, claude 5h 27% used")
    expect(usageTriggerLabel("droid", { ...w("weekly", 90, 10_080, "core") })).toBe("Usage limits, droid core weekly 90% used")
  })
})
