import { beforeEach, describe, expect, it } from "vitest"

import { effortOptions, recentEfforts, rememberEffort } from "./effort"
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
