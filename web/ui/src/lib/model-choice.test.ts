import { describe, expect, it } from "vitest"

import {
  defaultModelFor,
  initialChoice,
  isUsable,
  loadPreferredModel,
  modelOptionsFor,
  orderHarnesses,
  savePreferredModel,
  unusableReason,
} from "./model-choice"
import type { HarnessInfo } from "./types"

const h = (name: string, over: Partial<HarnessInfo> = {}): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: false,
  hasImage: false,
  defaults: {},
  models: null,
  ...over,
})

const probed = (list: string[], defaultModel: string | null = null) => ({
  list,
  defaultModel,
  probedAt: "2026-08-26T00:00:00.000Z",
})

function memoryStorage(seed?: string) {
  let value = seed ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
    removeItem: () => {
      value = null
    },
  }
}

describe("orderHarnesses", () => {
  it("puts the built-ins in product order and leaves custom adapters after them", () => {
    const input = [h("droid"), h("custom-b"), h("cursor"), h("claude"), h("custom-a"), h("codex")]
    expect(orderHarnesses(input).map((entry) => entry.name)).toEqual([
      "claude",
      "codex",
      "cursor",
      "droid",
      "custom-b",
      "custom-a",
    ])
    expect(input[0]?.name).toBe("droid") // sorting the menu never mutates query data
  })
})

describe("modelOptionsFor", () => {
  it("is empty when the machine reported no models and none is configured", () => {
    expect(modelOptionsFor(h("droid"))).toEqual([])
  })

  it("uses a configured default as the whole list when the probe returned nothing", () => {
    // we know a model id, so there is nothing for the user to type
    expect(modelOptionsFor(h("droid", { defaults: { model: "kimi-k3" } }))).toEqual(["kimi-k3"])
  })

  it("prepends a configured default the probe did not return", () => {
    const x = h("codex", { defaults: { model: "gpt-5.6-luna" }, models: probed(["gpt-5.5"]) })
    expect(modelOptionsFor(x)).toEqual(["gpt-5.6-luna", "gpt-5.5"])
  })

  it("does not duplicate a default the probe already has", () => {
    expect(modelOptionsFor(h("codex", { defaults: { model: "a" }, models: probed(["a", "b"]) }))).toEqual(["a", "b"])
  })
})

describe("isUsable / unusableReason", () => {
  it("a harness with any nameable model is usable", () => {
    expect(isUsable(h("codex", { models: probed(["a"]) }))).toBe(true)
    expect(isUsable(h("droid", { defaults: { model: "k" } }))).toBe(true)
  })

  it("a harness with no nameable model is not usable", () => {
    expect(isUsable(h("droid"))).toBe(false)
  })

  it("prefers the daemon's own probe error as the reason", () => {
    expect(unusableReason(h("droid", { modelsError: "bin not found" }))).toBe("bin not found")
  })

  it("distinguishes never-probed from probed-and-empty", () => {
    expect(unusableReason(h("droid"))).toBe("not probed on this machine")
    expect(unusableReason(h("droid", { models: probed([]) }))).toBe("no models reported")
  })
})

describe("defaultModelFor", () => {
  it("prefers the configured default over the probed one", () => {
    expect(defaultModelFor(h("x", { defaults: { model: "cfg" }, models: probed(["p"], "p") }))).toBe("cfg")
  })

  it("falls back to the probed default", () => {
    expect(defaultModelFor(h("x", { models: probed(["p"], "p") }))).toBe("p")
  })
})

describe("initialChoice", () => {
  it("uses an available preferred harness and model before product-order fallback", () => {
    const harnesses = [
      h("claude", { models: probed(["claude-a"], "claude-a") }),
      h("codex", { models: probed(["codex-a", "codex-b"], "codex-a") }),
    ]
    expect(initialChoice(harnesses, { harness: "codex", model: "codex-b" })).toEqual({
      harness: "codex",
      model: "codex-b",
    })
  })

  it("falls back normally when the preferred harness or model is unavailable", () => {
    const harnesses = [
      h("claude", { models: probed(["claude-a"], "claude-a") }),
      h("codex", { models: probed(["codex-a"], "codex-a") }),
    ]
    expect(initialChoice(harnesses, { harness: "missing", model: "anything" })).toEqual({
      harness: "claude",
      model: "claude-a",
    })
    expect(initialChoice(harnesses, { harness: "codex", model: "retired" })).toEqual({
      harness: "claude",
      model: "claude-a",
    })
  })

  it("skips an unusable first harness so the composer opens ready to submit", () => {
    // a real daemon reports droid first with models:null when its bin is absent
    const choice = initialChoice([h("droid"), h("codex", { models: probed(["gpt-5.6-luna"], "gpt-5.6-luna") })])
    expect(choice).toEqual({ harness: "codex", model: "gpt-5.6-luna" })
  })

  it("honours a configured default over the probed order", () => {
    expect(initialChoice([h("codex", { defaults: { model: "b" }, models: probed(["a", "b"], "a") })])).toEqual({
      harness: "codex",
      model: "b",
    })
  })

  it("is null when NO harness on this machine is usable", () => {
    // the composer then has nothing to submit, and says so rather than
    // offering a text box to guess into
    expect(initialChoice([h("droid"), h("claude")])).toBeNull()
  })

  it("is null with no harnesses at all", () => {
    expect(initialChoice([])).toBeNull()
  })
})

describe("preferred model persistence", () => {
  it("round-trips one choice and clears it", () => {
    const storage = memoryStorage()
    savePreferredModel({ harness: "codex", model: "gpt-5.6-luna" }, storage)
    expect(loadPreferredModel(storage)).toEqual({ harness: "codex", model: "gpt-5.6-luna" })

    savePreferredModel(null, storage)
    expect(loadPreferredModel(storage)).toBeNull()
  })

  it.each([
    "not json",
    "[]",
    "{}",
    '{"harness":"codex"}',
    '{"harness":"","model":"gpt"}',
    '{"harness":"codex","model":42}',
  ])("ignores malformed storage: %s", (raw) => {
    expect(loadPreferredModel(memoryStorage(raw))).toBeNull()
  })
})
