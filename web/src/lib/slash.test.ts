import { describe, expect, it } from "vitest"

import {
  commandEntries,
  compactEntry,
  slashName,
  slashScore,
  slashTokenAt,
  slashValue,
  TIER1_ENTRIES,
  tier2Entries,
  tier3Entries,
} from "./slash"

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

describe("commandEntries", () => {
  it("prefills the harness command and its argument hint without executing it", () => {
    expect(
      commandEntries([
        {
          name: "release",
          description: "Prepare a release",
          argumentHint: "[version]",
          executable: false,
        },
      ]),
    ).toEqual([
      {
        name: "release",
        hint: "Prepare a release · [version]",
        keywords: ["command", "custom"],
        prefill: "/release ",
        command: true,
        costLabel: "runs a turn",
      },
    ])
  })

  it("warns when sending the command may execute a script", () => {
    expect(
      commandEntries([
        {
          name: "verify",
          description: null,
          argumentHint: null,
          executable: true,
        },
      ])[0]!.costLabel,
    ).toBe("may run a script")
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

describe("slashScore (what the row under the cursor answers to)", () => {
  /** The real palette for a claude task: Tier 1, its two reads, and compact. */
  const ENTRIES = [
    ...TIER1_ENTRIES,
    ...tier2Entries(["context", "usage"]),
    ...compactEntry({ kind: "action", recordsTurn: false }),
  ]

  /** Every row that survives, best first — cmdk sorts by score descending. */
  const ranked = (query: string): string[] =>
    ENTRIES.map((entry) => ({ name: entry.name, score: slashScore(slashValue(entry), query, entry.keywords) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.name)

  it("puts the command you actually named first, ahead of rows that merely alias it", () => {
    // the bug: /fresh and /compact both carry `context` as an alias, and cmdk
    // scored all three at 0.891, so list order decided and Enter ran /fresh
    expect(ranked("context")[0]).toBe("context")
    expect(ranked("compact")[0]).toBe("compact")
    expect(ranked("usage")[0]).toBe("usage")
    expect(ranked("push")[0]).toBe("push")
  })

  it("scores an exact name above every alias, whatever the alias matched", () => {
    expect(slashScore("probe:context", "context", ["context", "tokens"])).toBe(1)
    expect(slashScore("fresh", "context", ["reset", "context", "clear"])).toBeLessThan(1)
  })

  it("prefers the shortest completion while you are still typing", () => {
    expect(ranked("con")[0]).toBe("context")
    expect(ranked("stat")[0]).toBe("status")
    expect(ranked("tok")[0]).toBe("tokens")
  })

  it("keeps an alias as a way to FIND a name, ranked under every name match", () => {
    // nothing is named `reset`; the only way to reach /fresh is its alias
    expect(ranked("reset")).toEqual(["fresh"])
    expect(slashScore("fresh", "reset", ["reset"])).toBeGreaterThan(0)
  })

  it("still answers shorthand, and answers it with the right command", () => {
    // cmdk ranked /compact above /context here, because it scored the value
    // `probe:context` rather than the name
    expect(ranked("ctx")[0]).toBe("context")
  })

  it("drops noise rather than ranking it", () => {
    expect(slashScore("probe:usage", "status", ["usage", "limits"])).toBe(0)
    expect(ranked("zzzz")).toEqual([])
  })

  it("shows everything, in list order, before anything is typed", () => {
    expect(slashScore("probe:context", "", ["context"])).toBe(1)
    expect(slashScore("fresh", "   ", ["reset"])).toBe(1)
  })

  it("reads the command name out of a probe row's disambiguating value", () => {
    expect(slashName("probe:context")).toBe("context")
    expect(slashName("command:release")).toBe("release")
    expect(slashName("fresh")).toBe("fresh")
  })
})
