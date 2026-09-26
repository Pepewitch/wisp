import { describe, expect, it } from "vitest"

import type { HarnessLimitsEntry, LimitWindow } from "./types"
import { limitTone, mainWindows, resetsIn, ringReading, usageTriggerLabel, windowPools } from "./usage-limits"

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

const perModel = (id: string, usedPercent: number): LimitWindow => ({ ...w(id, usedPercent, 10_080), model: id })

describe("the ring's window", () => {
  it("is the shortest window, whatever the others have used", () => {
    // claude: 5h, never its busier week
    expect(ringReading(entry([w("5h", 33, 300), w("7d", 51, 10_080), perModel("Fable", 0)]))?.window.id).toBe("5h")
    // codex on a plan with a 5h window, whichever order it came in
    expect(ringReading(entry([w("7d", 30, 10_080), w("5h", 10, 300), w("credits", 25, null)]))?.window.id).toBe("5h")
    // codex on a team plan: no 5h, so 7d, never its credits
    expect(ringReading(entry([w("7d", 20, 10_080), w("credits", 60, null)]))?.window.id).toBe("7d")
  })

  it("shows a window with no fixed length only when there is nothing else", () => {
    expect(ringReading(entry([w("credits", 40, null)]))?.window.id).toBe("credits")
  })

  it("is droid's standard pool, never its core one", () => {
    const droid = entry([
      w("standard:5h", 12, 300, "standard"),
      w("standard:weekly", 40, 10_080, "standard"),
      w("core:5h", 90, 300, "core"),
    ])
    expect(ringReading(droid)?.window.id).toBe("standard:5h")
  })

  it("is nothing for a harness with no limits to show", () => {
    expect(ringReading(undefined)).toBeNull()
    expect(ringReading(entry([], "needs-key"))).toBeNull()
    expect(ringReading(entry([]))).toBeNull()
  })
})

describe("the ring's colour", () => {
  it("is the shown window's own until another main window reaches 99%", () => {
    expect(ringReading(entry([w("5h", 10, 300), w("7d", 98.9, 10_080)]))).toMatchObject({ tone: "normal", reached: null })
    expect(ringReading(entry([w("5h", 85, 300), w("7d", 50, 10_080)]))).toMatchObject({ tone: "warn", reached: null })
    const blocked = ringReading(entry([w("5h", 10, 300), w("7d", 99, 10_080), w("credits", 100, null)]))
    expect(blocked).toMatchObject({ tone: "reached", reached: { id: "credits" } })
    expect(blocked?.window.id).toBe("5h")
  })

  it("is red from 99% of the shown window itself", () => {
    expect(ringReading(entry([w("5h", 99, 300), w("7d", 40, 10_080)]))).toMatchObject({ tone: "reached", reached: null })
  })

  it("ignores a per-model window and a side pool at their limit", () => {
    expect(ringReading(entry([w("5h", 10, 300), w("7d", 20, 10_080), perModel("Fable", 100)]))?.tone).toBe("normal")
    const droid = entry([w("standard:5h", 10, 300, "standard"), w("core:weekly", 100, 10_080, "core")])
    expect(ringReading(droid)?.tone).toBe("normal")
  })
})

describe("main windows", () => {
  it("are the unnamed pool, or the first pool when every window has one, without per-model windows", () => {
    const ids = (windows: LimitWindow[]) => mainWindows(windows).map((x) => x.id)
    expect(ids([w("5h", 1, 300), perModel("Fable", 1), w("other:5h", 1, 300, "Other model")])).toEqual(["5h"])
    expect(ids([w("standard:5h", 1, 300, "standard"), w("core:5h", 1, 300, "core")])).toEqual(["standard:5h"])
  })
})

describe("tone", () => {
  it("warns from 80% and reads as reached from 99%", () => {
    expect(limitTone(79.9)).toBe("normal")
    expect(limitTone(80)).toBe("warn")
    expect(limitTone(98.9)).toBe("warn")
    expect(limitTone(99)).toBe("reached")
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
    expect(usageTriggerLabel("claude", ringReading(entry([w("5h", 27.4, 300)])))).toBe("Usage limits, claude 5h 27% used")
    expect(usageTriggerLabel("droid", ringReading(entry([w("weekly", 90, 10_080, "standard")])))).toBe(
      "Usage limits, droid standard weekly 90% used",
    )
  })

  it("names the window that made a short arc red", () => {
    expect(usageTriggerLabel("claude", ringReading(entry([w("5h", 10, 300), w("7d", 100, 10_080)])))).toBe(
      "Usage limits, claude 5h 10% used, 7d 100% used",
    )
  })
})
