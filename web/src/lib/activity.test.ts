import { describe, expect, it } from "vitest"

import {
  activityByTurn,
  conclusionText,
  fetchTurnActivity,
  stepsOf,
  summarizeStep,
  toolDetails,
} from "./activity"
import type { ActivityEvent } from "./types"
import { createFakeSse } from "@/test/fake-sse"
import type { StreamBlock, ToolActivityItem } from "@/stream/reducer"

const tool = (overrides: Partial<ToolActivityItem> = {}): ToolActivityItem => ({
  kind: "tool",
  id: "read-1",
  name: "Read",
  input: { file_path: "src/app.ts" },
  output: "ok",
  error: null,
  status: "completed",
  ...overrides,
})

describe("activityByTurn", () => {
  it("buckets canonical activity under the turn separator", () => {
    const blocks: StreamBlock[] = [
      { kind: "separator", turn: 1, end: null },
      { kind: "you", prompt: "do it" },
      {
        kind: "activity",
        items: [
          { kind: "text", id: "text-1", text: "Reading" },
          tool(),
        ],
      },
      { kind: "separator", turn: 1, end: "done" },
    ]
    const activity = activityByTurn(blocks)[1]!
    expect(activity.items.map((item) => item.kind)).toEqual(["text", "tool"])
    expect(activity.text).toBe("Reading")
    expect(stepsOf(activity)).toEqual([tool()])
  })

  it("defers and caches parent prose until a settled conclusion reads it", () => {
    let textReads = 0
    const text = {
      kind: "text" as const,
      id: "text-1",
      get text() {
        textReads += 1
        return "Still working"
      },
    }
    const activity = activityByTurn([
      { kind: "separator", turn: 1, end: null },
      { kind: "activity", items: [text] },
    ])[1]!

    expect(textReads).toBe(0)
    expect(activity.text).toBe("Still working")
    expect(activity.text).toBe("Still working")
    expect(textReads).toBe(1)
  })

  it("finds tool steps recursively inside subagents", () => {
    const nested = tool({ id: "nested" })
    const activity = {
      text: "",
      items: [{
        kind: "subagent" as const,
        id: "agent",
        agentId: null,
        title: "Inspect",
        agentType: null,
        model: null,
        effort: null,
        prompt: null,
        result: null,
        error: null,
        status: "running" as const,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        background: false,
        items: [nested],
      }],
    }
    expect(stepsOf(activity)).toEqual([nested])
  })
})

describe("fetchTurnActivity", () => {
  it("uses the structured stream and includes appends before turn-end", async () => {
    const fake = createFakeSse()
    let url = ""
    const promise = fetchTurnActivity("t5qmha", 2, {
      factory: (next) => {
        url = next
        return fake.source
      },
    })
    const started: ActivityEvent = {
      kind: "tool",
      id: "edit-1",
      parentId: null,
      phase: "started",
      name: "Edit",
      input: { file_path: "a.ts" },
    }
    fake.emit("backlog", { turn: 2, prompt: "fix it", activity: [started] })
    fake.emit("append", {
      turn: 2,
      activity: [{
        kind: "tool",
        id: "edit-1",
        parentId: null,
        phase: "completed",
        name: "tool",
        output: "Applied",
      }],
    })
    expect(fake.isClosed()).toBe(false)
    fake.emit("turn-end", { turn: 2, status: "done" })

    const activity = await promise
    expect(url).toBe("/api/tasks/t5qmha/log/stream?format=activity&turn=2")
    expect(stepsOf(activity)[0]).toMatchObject({
      id: "edit-1",
      name: "Edit",
      output: "Applied",
      status: "completed",
    })
    expect(fake.isClosed()).toBe(true)
  })

  it("ignores frames for another turn and resolves empty on turn-end", async () => {
    const fake = createFakeSse()
    const promise = fetchTurnActivity("t5qmha", 1, { factory: () => fake.source })
    fake.emit("backlog", { turn: 2, prompt: "other", activity: [] })
    fake.emit("turn-end", { turn: 1, status: "done" })
    await expect(promise).resolves.toEqual({ items: [], text: "" })
  })

  it("closes the SSE immediately when a historical read is cancelled", async () => {
    const fake = createFakeSse()
    const controller = new AbortController()
    const promise = fetchTurnActivity("t5qmha", 1, {
      factory: () => fake.source,
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.isClosed()).toBe(true)
  })

  it("rejects instead of presenting a partial timeline when the stream closes early", async () => {
    const fake = createFakeSse()
    const promise = fetchTurnActivity("t5qmha", 1, { factory: () => fake.source })
    fake.emit("backlog", {
      turn: 1,
      prompt: "inspect",
      activity: [{ kind: "text", id: "partial", parentId: null, text: "Still working" }],
    })
    fake.fail()
    await expect(promise).rejects.toThrow("Activity stream closed before turn 1 completed")
    expect(fake.isClosed()).toBe(true)
  })

  it("rejects instead of presenting a partial timeline when the read times out", async () => {
    const fake = createFakeSse()
    const promise = fetchTurnActivity("t5qmha", 3, {
      factory: () => fake.source,
      timeoutMs: 1,
    })
    await expect(promise).rejects.toThrow("Timed out loading activity for turn 3")
    expect(fake.isClosed()).toBe(true)
  })
})

describe("tool summaries", () => {
  it("shows the useful path or command rather than serialized arguments", () => {
    expect(summarizeStep(tool()).arg).toBe("src/app.ts")
    expect(summarizeStep(tool({ name: "Run", input: { command: "bun test" } })).arg).toBe("bun test")
  })

  it("uses only short output as the right-edge fact", () => {
    expect(summarizeStep(tool({ output: "7 passed" })).note).toBe("7 passed")
    expect(summarizeStep(tool({ output: "x".repeat(80) })).note).toBeNull()
  })

  it("keeps full input, output, and errors in expanded details", () => {
    const details = toolDetails(tool({ error: "Exited 1", output: "partial output" }))
    expect(details).toContain('"file_path": "src/app.ts"')
    expect(details).toContain("partial output")
    expect(details).toContain("Error: Exited 1")
  })
})

/**
 * conclusionText is the one-conclusion-per-turn rule: the block renders only
 * when it ADDS something. The parse layer guarantees turn.result is the
 * turn's concluding prose, so a timeline already showing that prose in full
 * makes the block a verbatim repeat (the cursor bug was this repeat, at
 * whole-transcript scale); a timeline that truncates it — the 300-char prose
 * cap, a budget prefix, a mid-delivery live stream — makes the block the
 * only full copy.
 */
describe("conclusionText", () => {
  it("never prints for a running turn", () => {
    expect(conclusionText({ status: "running", result: "partial" }, undefined)).toBeNull()
    expect(conclusionText({ status: "running", result: "partial" }, "partial")).toBeNull()
  })

  it("renders when no timeline is on screen — the block is the only rendering", () => {
    expect(conclusionText({ status: "done", result: "the final word" }, undefined)).toBe("the final word")
  })

  it("withholds when the on-screen timeline already shows the conclusion in full", () => {
    const timeline = "→ shell({})\n← shell({})\ndone\n✓ turn complete\n"
    expect(conclusionText({ status: "done", result: "done" }, timeline)).toBeNull()
  })

  it("keeps the block when the timeline holds only a truncated copy", () => {
    // the human formatter caps assistant prose at 300 chars: a 948-char
    // verdict arrives in the timeline as its first 300 chars + "…"
    const full = "x".repeat(948)
    expect(conclusionText({ status: "done", result: full }, `${"x".repeat(300)}…\n`)).toBe(full)
  })

  it("keeps the block on a prefix-truncated timeline — it cannot contain the conclusion", () => {
    expect(conclusionText({ status: "done", result: "the verdict" }, "the turn's beginning only\n")).toBe(
      "the verdict",
    )
  })

  it("renders nothing without a result either way", () => {
    expect(conclusionText({ status: "done", result: null }, undefined)).toBeNull()
    expect(conclusionText({ status: "failed", result: null }, undefined)).toBeNull()
  })
})
