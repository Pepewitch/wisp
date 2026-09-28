import { describe, expect, it } from "vitest"

import { briefBand, briefInput, briefMenuNote, type BriefView } from "@/lib/brief"

const NOW = Date.parse("2026-09-28T10:12:00Z")

const view = (over: Partial<BriefView> = {}): BriefView => ({
  enabled: true,
  generation: 1,
  archived: false,
  harness: "codex",
  supported: true,
  activation: "next-turn",
  report: {
    turn: { n: 4, status: "done", contextN: 1, endedAt: "2026-09-28T10:00:00Z" },
    revision: 1,
    savedAt: "2026-09-28T10:00:00Z",
    brief: { version: 1, outcome: "Fixed the toolbar path.", remaining: [] },
  },
  latestEligibleTurn: { n: 4, status: "done", reported: true },
  latestTurn: { n: 4, status: "done", contextN: 1 },
  latestInput: null,
  reasons: [],
  ...over,
})

function report(model: ReturnType<typeof briefBand>) {
  if (model.kind !== "report") throw new Error(`expected a report band, got ${model.kind}`)
  return model
}

describe("the brief band", () => {
  it("renders nothing while loading, and nothing when the switch is off", () => {
    expect(briefBand(undefined, null, NOW)).toEqual({ kind: "hidden" })
    expect(briefBand(view({ enabled: false }), null, NOW)).toEqual({ kind: "hidden" })
  })

  it("a failed read says so and carries its repair", () => {
    expect(briefBand(undefined, new Error("offline"), NOW)).toEqual({ kind: "line", text: "Couldn't load the brief.", retry: true })
  })

  it("an empty brief never guesses why a report is missing", () => {
    const empty = (over: Partial<BriefView>) => briefBand(view({ report: null, ...over }), null, NOW)
    expect(empty({ latestEligibleTurn: null })).toEqual({ kind: "line", text: "Starts with the next turn." })
    expect(empty({ reasons: ["awaiting-next-turn", "no-report"] })).toMatchObject({ text: "Starts with the next turn — this one began before briefs were on." })
    expect(empty({ latestEligibleTurn: { n: 5, status: "running", reported: false } })).toMatchObject({ text: "Turn 5 is running; its brief comes at the end." })
    expect(empty({ latestEligibleTurn: { n: 5, status: "done", reported: false } })).toMatchObject({ text: "Turn 5 ended without one." })
    expect(empty({ supported: false, harness: "opencode" })).toMatchObject({ text: "opencode can't write briefs through Wisp yet." })
  })

  it("the collapsed line leads with a waiting decision, otherwise the result", () => {
    expect(report(briefBand(view(), null, NOW)).headline).toEqual({ label: null, text: "Fixed the toolbar path." })
    const decision = { question: "Store or button?", recommendation: null, options: [{ label: "Store", gain: "g", downside: "d", impact: "i", effort: null }], alternativesNote: "Not explored." }
    const withDecision = view({ report: { ...view().report!, brief: { ...view().report!.brief, decision } } })
    expect(report(briefBand(withDecision, null, NOW)).headline).toEqual({ label: "Decision", text: "Store or button?" })
  })

  it("the one freshness fact is the most consequential one, and never a claim of completion", () => {
    const fact = (over: Partial<BriefView>) => report(briefBand(view(over), null, NOW)).status
    expect(fact({})).toEqual(["turn 4", "12 min ago"])
    expect(fact({ reasons: ["provisional"] })).toEqual(["turn 4", "still running"])
    expect(fact({ reasons: ["source-failed"] })).toEqual(["turn 4", "that turn failed"])
    expect(fact({ reasons: ["source-interrupted", "newer-input"] })).toEqual(["turn 4", "that turn was stopped"])
    expect(fact({ reasons: ["newer-turn", "newer-turn-unreported"], latestEligibleTurn: { n: 5, status: "done", reported: false } }))
      .toEqual(["turn 4", "turn 5 sent none"])
    expect(fact({ reasons: ["newer-turn"], latestTurn: { n: 5, status: "running", contextN: 1 } })).toEqual(["turn 4", "turn 5 running"])
    expect(fact({ reasons: ["newer-input"] })).toEqual(["turn 4", "older than your latest message"])
    expect(fact({ reasons: ["input-uncertain"], latestInput: { ...input(), kind: "answer", delivery: "uncertain" } }))
      .toEqual(["turn 4", "your latest answer may not have arrived"])
    expect(fact({ reasons: ["newer-context"] })).toEqual(["turn 4", "before the fresh context"])
    for (const reasons of [[], ["newer-input"], ["provisional"]] as const) {
      expect(fact({ reasons: [...reasons] }).join(" ")).not.toMatch(/complete|verified|done|up to date/i)
    }
  })

  it("the divider says whose words follow, and when they predate yours", () => {
    const divider = (over: Partial<BriefView>) => report(briefBand(view(over), null, NOW)).divider
    expect(divider({})).toBe("The agent's report")
    expect(divider({ reasons: ["newer-input"] })).toBe("The agent's report — written before your latest input")
    expect(divider({ reasons: ["input-changed"] })).toBe("The agent's report — your input changed since")
    expect(divider({ supported: false, harness: "opencode" })).toBe("The agent's report — opencode can't write new ones")
  })

  it("a report's key changes with its turn or revision, so a disclosure never carries over", () => {
    expect(report(briefBand(view(), null, NOW)).key).toBe("4:1")
    expect(report(briefBand(view({ report: { ...view().report!, revision: 2 } }), null, NOW)).key).toBe("4:2")
  })
})

function input(): NonNullable<BriefView["latestInput"]> {
  return {
    kind: "message",
    id: "m1",
    text: "Also check autosave.\nKeep the API.",
    truncated: false,
    length: 34,
    question: null,
    delivery: "steered",
    turnN: 4,
    at: "2026-09-28T10:02:00Z",
    legacy: false,
  }
}

describe("your latest words", () => {
  it("are labelled by kind and captioned with Wisp's own delivery facts", () => {
    expect(briefInput(input(), NOW)).toEqual({
      label: "You asked",
      question: null,
      text: "Also check autosave.\nKeep the API.",
      truncated: false,
      caption: ["sent mid-turn 4", "10 min ago"],
      find: { query: "Also check autosave.", turn: 4 },
    })
    expect(briefInput({ ...input(), delivery: "queued", turnN: null }, NOW)?.caption).toEqual(["queued for the next turn"])
    expect(briefInput({ ...input(), kind: "task-prompt", delivery: "started", turnN: 1 }, NOW)?.caption[0]).toBe("task prompt, as stored")
    expect(briefInput({ ...input(), legacy: true }, NOW)?.caption).toContain("recorded before briefs existed")
  })

  it("an answer keeps its question, which is what gives 'yes' a meaning", () => {
    const answer = briefInput({ ...input(), kind: "answer", text: "yes", question: "Keep the old export?", delivery: "delivered" }, NOW)
    expect(answer).toMatchObject({ label: "You answered", question: "Keep the old export?", caption: ["answered in turn 4", "10 min ago"] })
  })
})

describe("the task menu's note", () => {
  const base = { enabled: false, supported: true, harness: "codex", running: false, justEnabled: false }
  it("explains the cost before it is on, and the timing right after", () => {
    expect(briefMenuNote(base)).toContain("One extra step per turn")
    expect(briefMenuNote({ ...base, enabled: true, justEnabled: true })).toBe("Starts with the next turn.")
    expect(briefMenuNote({ ...base, enabled: true, justEnabled: true, running: true })).toBe("Starts with the next turn — this one began before briefs were on.")
    expect(briefMenuNote({ ...base, enabled: true })).toBeNull()
    expect(briefMenuNote({ ...base, supported: false, harness: "opencode" })).toBe("opencode can't write briefs through Wisp yet.")
  })
})
