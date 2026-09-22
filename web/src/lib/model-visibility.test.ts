import { describe, expect, it } from "vitest"

import {
  hiddenCountFor,
  hiddenTotal,
  hideModel,
  isHidden,
  modelTotals,
  pickerHarnesses,
  setHarnessHidden,
  showModel,
  toggleModel,
  visibleModelsFor,
} from "@/lib/model-visibility"
import type { HarnessInfo } from "@/lib/types"

const harness = (name: string, models: string[], configModel?: string): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: false,
  hasImage: false,
  defaults: configModel ? { model: configModel } : {},
  models: { list: models, defaultModel: models[0] ?? null, probedAt: "2026-09-22T00:00:00.000Z" },
})

const claude = harness("claude", ["opus", "sonnet", "haiku"])
const codex = harness("codex", ["luna", "astra"])

describe("visibleModelsFor", () => {
  it("drops the hidden ids and keeps the rest in probe order", () => {
    expect(visibleModelsFor(claude, { claude: ["sonnet"] })).toEqual(["opus", "haiku"])
  })

  it("never filters out the model the caller is currently showing", () => {
    // a running task on a model hidden after it started: the menu must still
    // carry the row its radio value points at, or nothing is checked
    expect(visibleModelsFor(claude, { claude: ["opus", "sonnet"] }, "opus")).toEqual([
      "opus",
      "haiku",
    ])
  })

  it("hiding is scoped to one harness, never to a model id across harnesses", () => {
    const shared = harness("cursor", ["luna", "auto"])
    expect(visibleModelsFor(shared, { codex: ["luna"] })).toEqual(["luna", "auto"])
  })

  it("a configured default is offered even when the probe never listed it", () => {
    const pinned = harness("droid", ["kimi"], "glm")
    expect(visibleModelsFor(pinned, {})).toEqual(["glm", "kimi"])
    expect(visibleModelsFor(pinned, { droid: ["glm"] })).toEqual(["kimi"])
  })
})

describe("counting", () => {
  it("counts per harness and across all of them", () => {
    const hidden = { claude: ["sonnet", "haiku"], codex: ["astra"] }
    expect(hiddenCountFor(claude, hidden)).toBe(2)
    expect(hiddenTotal([claude, codex], hidden)).toBe(3)
    expect(modelTotals([claude, codex], hidden)).toEqual({ shown: 2, total: 5 })
  })

  it("an id hidden but no longer offered does not inflate the count", () => {
    // a probe dropped `retired`; the curation keeps it, but it is not a model
    // this harness offers any more, so it is not 'hidden from' anything
    expect(hiddenCountFor(claude, { claude: ["retired"] })).toBe(0)
  })
})

describe("pickerHarnesses", () => {
  it("drops a harness whose models are all hidden", () => {
    const shown = pickerHarnesses([claude, codex], { codex: ["luna", "astra"] })
    expect(shown.map((h) => h.name)).toEqual(["claude"])
  })

  it("keeps a fully hidden harness when the current choice still lives there", () => {
    const shown = pickerHarnesses([claude, codex], { codex: ["luna", "astra"] }, {
      harness: "codex",
      model: "luna",
    })
    expect(shown.map((h) => h.name)).toEqual(["claude", "codex"])
  })

  it("keeps an unusable harness, which has no models to hide and a reason to show", () => {
    const broken: HarnessInfo = {
      name: "droid",
      hasModel: true,
      hasEffort: false,
      hasImage: false,
      defaults: {},
      models: null,
      modelsError: "'droid' not found on PATH",
    }
    expect(pickerHarnesses([broken], {}).map((h) => h.name)).toEqual(["droid"])
  })
})

describe("writing a curation", () => {
  it("stores deduped, sorted ids and drops a harness that hides nothing", () => {
    const once = hideModel({}, "claude", "sonnet")
    const twice = hideModel(once, "claude", "opus")
    expect(twice).toEqual({ claude: ["opus", "sonnet"] })
    expect(hideModel(twice, "claude", "sonnet")).toEqual({ claude: ["opus", "sonnet"] })
    expect(showModel(showModel(twice, "claude", "opus"), "claude", "sonnet")).toEqual({})
  })

  it("toggle is its own inverse", () => {
    const hidden = toggleModel({}, "codex", "astra")
    expect(isHidden(hidden, "codex", "astra")).toBe(true)
    expect(toggleModel(hidden, "codex", "astra")).toEqual({})
  })

  it("hide all / show all is one decision per harness, and leaves others alone", () => {
    const start = { codex: ["astra"] }
    const all = setHarnessHidden(start, claude, true)
    expect(all).toEqual({ codex: ["astra"], claude: ["haiku", "opus", "sonnet"] })
    expect(setHarnessHidden(all, claude, false)).toEqual({ codex: ["astra"] })
  })

  it("never mutates the curation it was handed", () => {
    const start = { claude: ["sonnet"] }
    hideModel(start, "claude", "opus")
    setHarnessHidden(start, claude, true)
    expect(start).toEqual({ claude: ["sonnet"] })
  })
})
