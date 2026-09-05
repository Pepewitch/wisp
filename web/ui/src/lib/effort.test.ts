import { beforeEach, describe, expect, it } from "vitest"

import { effortOptions, recentEfforts, rememberEffort } from "./effort"
import type { HarnessInfo } from "./types"

const h = (name: string, reasoningEffort?: string, effortLevels?: string[]): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: true,
  hasImage: false,
  defaults: reasoningEffort ? { reasoningEffort } : {},
  models: null,
  ...(effortLevels ? { effortLevels } : {}),
})

beforeEach(() => localStorage.clear())

describe("rememberEffort / recentEfforts", () => {
  it("remembers newest first, per harness", () => {
    rememberEffort("codex", "high")
    rememberEffort("codex", "xhigh")
    rememberEffort("droid", "low")
    expect(recentEfforts("codex")).toEqual(["xhigh", "high"])
    expect(recentEfforts("droid")).toEqual(["low"])
  })

  it("moves a repeat to the front without duplicating it", () => {
    rememberEffort("codex", "high")
    rememberEffort("codex", "xhigh")
    rememberEffort("codex", "high")
    expect(recentEfforts("codex")).toEqual(["high", "xhigh"])
  })

  it("ignores blank values", () => {
    rememberEffort("codex", "   ")
    expect(recentEfforts("codex")).toEqual([])
  })

  it("caps the list", () => {
    for (const v of ["a", "b", "c", "d", "e", "f", "g"]) rememberEffort("codex", v)
    expect(recentEfforts("codex")).toEqual(["g", "f", "e", "d", "c", "b"])
  })

  it("survives hand-edited garbage in storage", () => {
    localStorage.setItem("wisp_effort_recents", '{"codex":["ok",42,null],"droid":"nope"}')
    expect(recentEfforts("codex")).toEqual(["ok"])
    expect(recentEfforts("droid")).toEqual([])
  })

  it("survives storage that is not JSON at all", () => {
    localStorage.setItem("wisp_effort_recents", "{{{")
    expect(recentEfforts("codex")).toEqual([])
  })
})

describe("effortOptions", () => {
  it("leads with the configured default", () => {
    rememberEffort("codex", "low")
    expect(effortOptions(h("codex", "xhigh"))).toEqual(["xhigh", "low"])
  })

  it("does not repeat the default when it was also used recently", () => {
    rememberEffort("codex", "xhigh")
    expect(effortOptions(h("codex", "xhigh"))).toEqual(["xhigh"])
  })

  it("is empty when nothing is configured and nothing was used — the picker\
 then offers only Custom, because inventing a level is how xhigh got dropped", () => {
    expect(effortOptions(h("droid"))).toEqual([])
  })
})

/**
 * The levels the daemon read off each CLI (src/adapters.ts effortLevels).
 * These arrive per harness and genuinely differ, so the picker renders what it
 * is given rather than a shared ladder.
 */
describe("effortOptions with daemon-declared levels", () => {
  it("offers the harness's own levels, in the order it named them", () => {
    // low→max reads as a ladder; re-sorting it would make the menu nonsense
    const levels = ["low", "medium", "high", "xhigh", "max"]
    expect(effortOptions(h("claude", undefined, levels))).toEqual(levels)
  })

  it("no longer leaves droid empty — the reported bug", () => {
    // droid declares nine levels but has no configured default, which used to
    // produce an empty menu and the "No level recorded" note
    const droid = h("droid", undefined, ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
    expect(effortOptions(droid)).toContain("dynamic")
    expect(effortOptions(droid)).toHaveLength(9)
  })

  it("does not duplicate the configured default when the harness declares it", () => {
    expect(effortOptions(h("codex", "xhigh", ["low", "high", "xhigh"]))).toEqual(["low", "high", "xhigh"])
  })

  it("still offers a level used here that the harness did not declare", () => {
    // a stale declared list must never HIDE a level that demonstrably works
    rememberEffort("codex", "ludicrous")
    expect(effortOptions(h("codex", undefined, ["low", "high"]))).toEqual(["low", "high", "ludicrous"])
  })

  it("falls back to local knowledge when the adapter declares nothing", () => {
    rememberEffort("custom", "medium")
    expect(effortOptions(h("custom", "high", []))).toEqual(["high", "medium"])
  })
})
