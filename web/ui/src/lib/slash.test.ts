import { describe, expect, it } from "vitest"

import { compactEntry, slashTokenAt, TIER1_ENTRIES, tier2Entries, tier3Entries } from "./slash"

describe("slashTokenAt (the trigger law)", () => {
  it("a slash on an empty draft or after whitespace is a command token", () => {
    expect(slashTokenAt("/", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(slashTokenAt("/st", 3)).toEqual({ start: 0, end: 3, query: "st" })
    expect(slashTokenAt("look at src/lib /st", 19)).toEqual({ start: 16, end: 19, query: "st" })
  })

  it("a slash inside a word is a word, not a command", () => {
    expect(slashTokenAt("src/lib", 6)).toBeNull()
  })

  it("the caret must sit inside the token", () => {
    expect(slashTokenAt("/st rest", 0)).toBeNull() // before the slash
    expect(slashTokenAt("/st rest", 6)).toBeNull() // past the token's end
  })
})

describe("Tier 1 commands", () => {
  it("keeps task telemetry under /tokens without aliasing the harness's /usage", () => {
    const tokens = TIER1_ENTRIES.find((entry) => entry.name === "tokens")
    expect(tokens).toMatchObject({
      hint: "task token totals by reported turn",
      keywords: ["turns", "reported", "total", "telemetry"],
    })
    expect(TIER1_ENTRIES.some((entry) => entry.name === "usage")).toBe(false)
  })
})

describe("tier2Entries (A3)", () => {
  it("the entries are the adapter's declared commands, carrying its own names", () => {
    expect(tier2Entries(["context", "usage"])).toEqual([
      { name: "context", probe: "context", hint: "the harness's own context report", keywords: expect.any(Array) },
      { name: "usage", probe: "usage", hint: "the harness's own plan and limits report", keywords: expect.any(Array) },
    ])
  })

  it("uneven availability is data, not code — droid has no usage read, codex no context read", () => {
    expect(tier2Entries(["context"]).map((e) => e.name)).toEqual(["context"])
    expect(tier2Entries(["usage"]).map((e) => e.name)).toEqual(["usage"])
    expect(tier2Entries([])).toEqual([])
    expect(tier2Entries(undefined)).toEqual([])
  })
})

describe("tier3Entries (A4)", () => {
  it("slash harnesses prefill /name; the hint is the harness's own description", () => {
    expect(
      tier3Entries([{ name: "code-review", description: "Review the diff" }], "slash"),
    ).toEqual([{ name: "code-review", hint: "Review the diff", keywords: ["skill"], prefill: "/code-review" }])
  })

  it("codex prefills a plain-text ask — a /name there would imply an invocation that does not exist", () => {
    expect(tier3Entries([{ name: "openai-docs", description: "docs" }], "prompt")[0]!.prefill).toBe(
      "use the openai-docs skill: ",
    )
  })

  it("a name-only skill renders name-only — dropped would be a lie, invented text worse", () => {
    expect(tier3Entries([{ name: "nameless-ok", description: null }], "slash")[0]!.hint).toBe("")
  })

  it("no registry, no entries", () => {
    expect(tier3Entries(undefined, undefined)).toEqual([])
    expect(tier3Entries([], "slash")).toEqual([])
  })
})

describe("compactEntry (A5)", () => {
  it("a prompt harness (claude) prefills its own command, marked as the turn it is", () => {
    expect(compactEntry({ kind: "prompt", prompt: "/compact" })).toEqual([
      {
        name: "compact",
        hint: "summarize the session to shrink its context",
        keywords: ["compact", "context", "summarize", "shrink"],
        prefill: "/compact",
        costLabel: "runs a turn",
      },
    ])
  })

  it("an action harness dispatches; recordsTurn decides 'runs a turn' vs 'costs tokens'", () => {
    const droid = compactEntry({ kind: "action", recordsTurn: false })[0]!
    expect(droid.compact).toBe(true)
    expect(droid.prefill).toBeUndefined()
    expect(droid.costLabel).toBe("costs tokens")

    const codex = compactEntry({ kind: "action", recordsTurn: true })[0]!
    expect(codex.costLabel).toBe("runs a turn")
    expect(codex.hint).toContain("the harness records it as a turn in its own history")
  })

  it("no compaction, no entry", () => {
    expect(compactEntry(null)).toEqual([])
    expect(compactEntry(undefined)).toEqual([])
  })
})
