import { describe, expect, it } from "vitest"

import type { ActivityEvent } from "@/lib/types"
import {
  initialStreamState,
  reduceActivity,
  streamReducer,
  youBlockDisplay,
  type SubagentActivityItem,
} from "./reducer"

const taskStart = (
  id: string,
  title: string,
  parentId: string | null = null,
): Extract<ActivityEvent, { kind: "subagent" }> => ({
  kind: "subagent",
  id,
  parentId,
  phase: "started",
  status: "running",
  title,
  agentType: "worker",
})

describe("structured stream reducer", () => {
  it("resets and opens a turn without clearing a connection note on empty activity", () => {
    const reset = streamReducer(
      { blocks: [{ kind: "raw", text: "old" }], currentTurn: 2, note: null },
      { type: "reset", note: "connecting…" },
    )
    expect(reset).toEqual({ blocks: [], currentTurn: 0, note: "connecting…" })

    const opened = streamReducer(reset, { type: "backlog", turn: 1, prompt: "do it", activity: [] })
    expect(opened.blocks).toEqual([
      { kind: "separator", turn: 1, end: null },
      { kind: "you", prompt: "do it" },
    ])
    expect(opened.note).toBe("connecting…")
  })

  it("folds activity into one ordered block and releases it when the turn settles", () => {
    let state = streamReducer(initialStreamState, {
      type: "backlog",
      turn: 1,
      prompt: "p",
      activity: [{ kind: "text", id: "t1", parentId: null, text: "Starting" }],
    })
    state = streamReducer(state, {
      type: "append",
      turn: 1,
      activity: [{ kind: "text", id: "t2", parentId: null, text: "Done" }],
    })
    expect(state.blocks.at(-1)).toEqual({
      kind: "activity",
      items: [{ kind: "text", id: "t1", text: "Starting\nDone" }],
    })

    state = streamReducer(state, { type: "turn-end", turn: 1, status: "done" })
    expect(state.blocks).toEqual([])
    expect(state.currentTurn).toBe(0)
  })

  it("keeps raw format byte-exact and separate from structured activity", () => {
    let state = streamReducer(initialStreamState, {
      type: "raw-backlog",
      turn: 1,
      prompt: "p",
      text: '{"type":"tool_call"',
    })
    state = streamReducer(state, { type: "raw-append", turn: 1, text: "}\n" })
    expect(state.blocks.at(-1)).toEqual({ kind: "raw", text: '{"type":"tool_call"}\n' })
  })

  it("returns the same stream state for a repeated no-op lifecycle frame", () => {
    const completed: ActivityEvent = {
      kind: "tool",
      id: "read",
      parentId: null,
      phase: "completed",
      name: "Read",
      output: "done",
    }
    const state = streamReducer(initialStreamState, {
      type: "append",
      turn: 1,
      activity: [completed],
    })
    expect(streamReducer(state, { type: "append", turn: 1, activity: [completed] })).toBe(state)
  })
})

describe("activity tree", () => {
  it("correlates parallel tool results by id instead of adjacency", () => {
    const items = reduceActivity([], [
      { kind: "tool", id: "a", parentId: null, phase: "started", name: "Read", input: { file_path: "a.ts" } },
      { kind: "tool", id: "b", parentId: null, phase: "started", name: "Read", input: { file_path: "b.ts" } },
      { kind: "tool", id: "a", parentId: null, phase: "completed", name: "tool", output: "A" },
      { kind: "tool", id: "b", parentId: null, phase: "completed", name: "tool", output: "B" },
    ])
    expect(items).toMatchObject([
      { id: "a", name: "Read", output: "A", status: "completed" },
      { id: "b", name: "Read", output: "B", status: "completed" },
    ])
  })

  it("preserves the tree reference when a repeated lifecycle frame changes nothing", () => {
    const completed: ActivityEvent = {
      kind: "tool",
      id: "read",
      parentId: null,
      phase: "completed",
      name: "tool",
      output: "done",
    }
    const items = reduceActivity([], [
      { kind: "tool", id: "read", parentId: null, phase: "started", name: "Read", input: null },
      completed,
    ])
    expect(reduceActivity(items, [completed])).toBe(items)
  })

  it("places nested child activity under the correct subagent", () => {
    const items = reduceActivity([], [
      taskStart("agent-a", "Review A"),
      taskStart("agent-b", "Review B"),
      {
        kind: "tool",
        id: "read-a",
        parentId: "agent-a",
        phase: "started",
        name: "Read",
        input: { file_path: "a.ts" },
      },
      { kind: "text", id: "text-b", parentId: "agent-b", text: "Found an issue" },
    ]) as SubagentActivityItem[]

    expect(items[0]!.items).toMatchObject([{ kind: "tool", id: "read-a" }])
    expect(items[1]!.items).toEqual([{ kind: "text", id: "text-b", text: "Found an issue" }])
  })

  it("renders nested subagents recursively at their event position", () => {
    const items = reduceActivity([], [
      taskStart("parent", "Parent"),
      { kind: "text", id: "before", parentId: "parent", text: "Before child" },
      taskStart("child", "Child", "parent"),
      { kind: "thinking", id: "thought", parentId: "child", text: "Checking" },
      { kind: "text", id: "after", parentId: "parent", text: "After child" },
    ])
    const parent = items[0] as SubagentActivityItem
    expect(parent.items.map((item) => item.kind)).toEqual(["text", "subagent", "text"])
    expect((parent.items[1] as SubagentActivityItem).items).toEqual([
      { kind: "thinking", id: "thought", text: "Checking" },
    ])
  })

  it("matches a later lifecycle update through the child agent id", () => {
    const items = reduceActivity([], [
      taskStart("spawn-call", "Review"),
      {
        kind: "subagent",
        id: "spawn-call",
        agentId: "thread-1",
        parentId: null,
        phase: "updated",
        status: "running",
      },
      {
        kind: "subagent",
        id: "thread-1",
        agentId: "thread-1",
        parentId: null,
        phase: "completed",
        status: "failed",
        error: "Review crashed",
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "spawn-call",
      agentId: "thread-1",
      title: "Review",
      status: "failed",
      error: "Review crashed",
    })
  })

  it("keeps metadata and nested activity when a lifecycle update is sparse", () => {
    const items = reduceActivity([], [
      { ...taskStart("agent", "Inspect"), model: "sonnet-5", effort: "medium" },
      { kind: "text", id: "child-text", parentId: "agent", text: "Working" },
      {
        kind: "subagent",
        id: "agent",
        parentId: null,
        phase: "completed",
        status: "completed",
        result: "Done",
      },
    ])
    expect(items[0]).toMatchObject({
      title: "Inspect",
      model: "sonnet-5",
      effort: "medium",
      status: "completed",
      result: "Done",
      items: [{ kind: "text", text: "Working" }],
    })
  })

  it("does not treat a completion timestamp as the start, which would render 0s", () => {
    const items = reduceActivity([], [
      {
        kind: "subagent",
        id: "agent",
        parentId: null,
        phase: "started",
        status: "running",
        title: "Commit the RED tests",
      },
      {
        kind: "subagent",
        id: "agent",
        parentId: null,
        phase: "completed",
        status: "completed",
        timestamp: "2026-09-03T09:50:08.348Z",
        result: "committed",
        durationMs: 3820,
      },
    ])
    expect(items[0]).toMatchObject({
      startedAt: null,
      endedAt: "2026-09-03T09:50:08.348Z",
      durationMs: 3820,
    })
  })

  it("keeps the start timestamp from the running event when the child settles", () => {
    const items = reduceActivity([], [
      {
        kind: "subagent",
        id: "agent",
        parentId: null,
        phase: "started",
        status: "running",
        title: "Explore",
        timestamp: "2026-09-01T15:22:29.969Z",
      },
      {
        kind: "subagent",
        id: "agent",
        parentId: null,
        phase: "completed",
        status: "completed",
        timestamp: "2026-09-01T15:22:33.956Z",
        durationMs: 3980,
      },
    ])
    expect(items[0]).toMatchObject({
      startedAt: "2026-09-01T15:22:29.969Z",
      endedAt: "2026-09-01T15:22:33.956Z",
      durationMs: 3980,
    })
  })
})

describe("a message steered into a running turn", () => {
  it("keeps its place between the prose before it and the prose after it", () => {
    const items = reduceActivity(
      [],
      [
        { kind: "text", id: "t1", parentId: null, text: "Reading the config" },
        { kind: "message", id: "mfaketestid01", parentId: null, text: "Use the safer approach" },
        { kind: "text", id: "t2", parentId: null, text: "Switching approach" },
      ],
    )
    expect(items).toEqual([
      { kind: "text", id: "t1", text: "Reading the config" },
      { kind: "message", id: "mfaketestid01", text: "Use the safer approach" },
      { kind: "text", id: "t2", text: "Switching approach" },
    ])
  })

  it("survives a replay of the same log without stacking duplicates", () => {
    const events: ActivityEvent[] = [
      { kind: "text", id: "t1", parentId: null, text: "Reading the config" },
      { kind: "message", id: "mfaketestid01", parentId: null, text: "Use the safer approach" },
    ]
    const once = reduceActivity([], events)
    const twice = reduceActivity(once, events)
    expect(twice.filter((item) => item.kind === "message")).toHaveLength(1)
  })
})

describe("you-block display rule", () => {
  it("keeps short prompts inline", () => {
    expect(youBlockDisplay("fix the flaky web test")).toEqual({
      collapsible: false,
      summary: "you: fix the flaky web test",
    })
  })

  it("collapses paragraphs and caps long first lines", () => {
    expect(youBlockDisplay("first line\n\nsecond paragraph")).toEqual({
      collapsible: true,
      summary: "you: first line",
    })
    const long = "z".repeat(200)
    expect(youBlockDisplay(long).summary).toBe(`you: ${"z".repeat(120)}…`)
  })
})
