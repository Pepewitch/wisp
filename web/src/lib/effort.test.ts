import { beforeEach, describe, expect, it } from "vitest"

import {
  effortOptions,
  loadPreferredEfforts,
  preferredEffortFor,
  recentEfforts,
  rememberEffort,
  savePreferredEffort,
  seededEffort,
} from "./effort"
import { connectionStorageKey } from "./connection-storage"
import type { HarnessInfo } from "./types"

const LOCAL_CONNECTION = "local"
const REMOTE_CONNECTION = "remote-test"
const LEGACY_EFFORT_KEY = "wisp_effort_recents"
const SCOPED_EFFORT_NAME = "effort_recents"

const h = (
  name: string,
  reasoningEffort?: string,
  effortLevels?: string[]
): HarnessInfo => ({
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
    rememberEffort(LOCAL_CONNECTION, "codex", "high")
    rememberEffort(LOCAL_CONNECTION, "codex", "xhigh")
    rememberEffort(LOCAL_CONNECTION, "droid", "low")
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual(["xhigh", "high"])
    expect(recentEfforts(LOCAL_CONNECTION, "droid")).toEqual(["low"])
  })

  it("moves a repeat to the front without duplicating it", () => {
    rememberEffort(LOCAL_CONNECTION, "codex", "high")
    rememberEffort(LOCAL_CONNECTION, "codex", "xhigh")
    rememberEffort(LOCAL_CONNECTION, "codex", "high")
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual(["high", "xhigh"])
  })

  it("ignores blank values", () => {
    rememberEffort(LOCAL_CONNECTION, "codex", "   ")
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual([])
  })

  it("caps the list", () => {
    for (const v of ["a", "b", "c", "d", "e", "f", "g"])
      rememberEffort(LOCAL_CONNECTION, "codex", v)
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual([
      "g",
      "f",
      "e",
      "d",
      "c",
      "b",
    ])
  })

  it("survives hand-edited garbage in storage", () => {
    localStorage.setItem(
      LEGACY_EFFORT_KEY,
      '{"codex":["ok",42,null],"droid":"nope"}'
    )
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual(["ok"])
    expect(recentEfforts(LOCAL_CONNECTION, "droid")).toEqual([])
  })

  it("survives storage that is not JSON at all", () => {
    localStorage.setItem(LEGACY_EFFORT_KEY, "{{{")
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual([])
  })

  it("lazily migrates local recents while keeping remote connections isolated", () => {
    const legacy = JSON.stringify({ codex: ["high"] })
    localStorage.setItem(LEGACY_EFFORT_KEY, legacy)

    expect(recentEfforts(REMOTE_CONNECTION, "codex")).toEqual([])
    expect(localStorage.getItem(LEGACY_EFFORT_KEY)).toBe(legacy)

    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual(["high"])
    expect(localStorage.getItem(LEGACY_EFFORT_KEY)).toBeNull()
    expect(
      localStorage.getItem(
        connectionStorageKey(LOCAL_CONNECTION, SCOPED_EFFORT_NAME)
      )
    ).toBe(legacy)

    rememberEffort(REMOTE_CONNECTION, "codex", "low")
    expect(recentEfforts(REMOTE_CONNECTION, "codex")).toEqual(["low"])
    expect(recentEfforts(LOCAL_CONNECTION, "codex")).toEqual(["high"])
  })
})

describe("effortOptions", () => {
  it("leads with the configured default", () => {
    rememberEffort(LOCAL_CONNECTION, "codex", "low")
    expect(effortOptions(LOCAL_CONNECTION, h("codex", "xhigh"))).toEqual([
      "xhigh",
      "low",
    ])
  })

  it("does not repeat the default when it was also used recently", () => {
    rememberEffort(LOCAL_CONNECTION, "codex", "xhigh")
    expect(effortOptions(LOCAL_CONNECTION, h("codex", "xhigh"))).toEqual([
      "xhigh",
    ])
  })

  it("is empty when nothing is configured and nothing was used — the picker\
 then offers only Custom, because inventing a level is how xhigh got dropped", () => {
    expect(effortOptions(LOCAL_CONNECTION, h("droid"))).toEqual([])
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
    expect(
      effortOptions(LOCAL_CONNECTION, h("claude", undefined, levels))
    ).toEqual(levels)
  })

  it("no longer leaves droid empty — the reported bug", () => {
    // droid declares nine levels but has no configured default, which used to
    // produce an empty menu and the "No level recorded" note
    const droid = h("droid", undefined, [
      "none",
      "dynamic",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(effortOptions(LOCAL_CONNECTION, droid)).toContain("dynamic")
    expect(effortOptions(LOCAL_CONNECTION, droid)).toHaveLength(9)
  })

  it("does not duplicate the configured default when the harness declares it", () => {
    expect(
      effortOptions(
        LOCAL_CONNECTION,
        h("codex", "xhigh", ["low", "high", "xhigh"])
      )
    ).toEqual(["low", "high", "xhigh"])
  })

  it("still offers a level used here that the harness did not declare", () => {
    // a stale declared list must never HIDE a level that demonstrably works
    rememberEffort(LOCAL_CONNECTION, "codex", "ludicrous")
    expect(
      effortOptions(LOCAL_CONNECTION, h("codex", undefined, ["low", "high"]))
    ).toEqual(["low", "high", "ludicrous"])
  })

  it("falls back to local knowledge when the adapter declares nothing", () => {
    rememberEffort(LOCAL_CONNECTION, "custom", "medium")
    expect(effortOptions(LOCAL_CONNECTION, h("custom", "high", []))).toEqual([
      "high",
      "medium",
    ])
  })
})

describe("preferred effort per harness · model", () => {
  const SCOPED_PREFERRED_NAME = "preferred_effort"
  const scoped = (connectionId: string) =>
    connectionStorageKey(connectionId, SCOPED_PREFERRED_NAME)

  it("stores one level per pair, and clearing the last one removes the key", () => {
    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", "high")
    savePreferredEffort(LOCAL_CONNECTION, "droid", "opus", "low")
    const preferred = savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", "max")
    expect(loadPreferredEfforts(LOCAL_CONNECTION)).toEqual(preferred)
    expect(preferredEffortFor(preferred, "claude", "opus")).toBe("max")
    expect(preferredEffortFor(preferred, "droid", "opus")).toBe("low")
    expect(preferredEffortFor(preferred, "claude", "sonnet")).toBeNull()
    expect(loadPreferredEfforts(REMOTE_CONNECTION)).toEqual({})

    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", null)
    expect(savePreferredEffort(LOCAL_CONNECTION, "droid", "opus", null)).toEqual({})
    expect(localStorage.getItem(scoped(LOCAL_CONNECTION))).toBeNull()
  })

  it("a save from one tab keeps the stars another tab saved since it loaded", () => {
    // two composers (or tabs) load before either stars anything
    const tabA = loadPreferredEfforts(LOCAL_CONNECTION)
    const tabB = loadPreferredEfforts(LOCAL_CONNECTION)
    expect(tabA).toEqual(tabB)
    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", "high")
    savePreferredEffort(LOCAL_CONNECTION, "claude", "sonnet", "low")
    const stored = loadPreferredEfforts(LOCAL_CONNECTION)
    expect(preferredEffortFor(stored, "claude", "opus")).toBe("high")
    expect(preferredEffortFor(stored, "claude", "sonnet")).toBe("low")
  })

  it("a star cleared in one tab is not brought back by another tab's save", () => {
    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", "high")
    // tab B loaded while claude · opus was still starred
    const tabB = loadPreferredEfforts(LOCAL_CONNECTION)
    expect(preferredEffortFor(tabB, "claude", "opus")).toBe("high")
    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", null)
    savePreferredEffort(LOCAL_CONNECTION, "droid", "opus", "low")
    expect(loadPreferredEfforts(LOCAL_CONNECTION)).toEqual({ "droid\u0000opus": "low" })
  })

  it("never adopts or writes an unscoped key", () => {
    localStorage.setItem("wisp_preferred_effort", JSON.stringify({ "claude\u0000opus": "high" }))
    expect(loadPreferredEfforts(LOCAL_CONNECTION)).toEqual({})
    savePreferredEffort(LOCAL_CONNECTION, "claude", "opus", "low")
    expect(localStorage.getItem("wisp_preferred_effort")).toBe(JSON.stringify({ "claude\u0000opus": "high" }))
    expect(localStorage.getItem(scoped(LOCAL_CONNECTION))).toBe(JSON.stringify({ "claude\u0000opus": "low" }))
  })

  it("survives hand-edited garbage in storage", () => {
    localStorage.setItem(
      scoped(REMOTE_CONNECTION),
      JSON.stringify({
        "claude\u0000opus": "high",
        "codex\u0000gpt": 42,
        "droid\u0000": "low",
        "no-separator": "low",
        "a\u0000b\u0000c": "low",
        "cursor\u0000auto": "  ",
      })
    )
    expect(loadPreferredEfforts(REMOTE_CONNECTION)).toEqual({ "claude\u0000opus": "high" })
    localStorage.setItem(scoped(REMOTE_CONNECTION), "[\"high\"]")
    expect(loadPreferredEfforts(REMOTE_CONNECTION)).toEqual({})
    localStorage.setItem(scoped(REMOTE_CONNECTION), "{{{")
    expect(loadPreferredEfforts(REMOTE_CONNECTION)).toEqual({})
  })

  it("seeds the star while it is offered, else the configured default", () => {
    const claude = h("claude", "medium", ["low", "medium", "high"])
    const preferred = { "claude\u0000opus": "high", "claude\u0000sonnet": "max" }
    expect(seededEffort(LOCAL_CONNECTION, claude, "opus", preferred)).toBe("high")
    // a level the harness no longer offers is ignored, not sent
    expect(seededEffort(LOCAL_CONNECTION, claude, "sonnet", preferred)).toBe("medium")
    expect(seededEffort(LOCAL_CONNECTION, claude, "haiku", preferred)).toBe("medium")
    expect(seededEffort(LOCAL_CONNECTION, h("droid"), "opus", preferred)).toBe("")
  })
})
