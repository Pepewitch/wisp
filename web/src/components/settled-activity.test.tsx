import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useLogStream } from "@/hooks/useLogStream"
import type { TurnActivity } from "@/lib/activity"
import { createConnectionQueryKeys } from "@/lib/query"
import type { ActivityEvent, ConversationDetail } from "@/lib/types"
import { initialStreamState } from "@/stream/reducer"
import { createFakeSse } from "@/test/fake-sse"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { Conversation } from "./conversation"

const read = (file: string): ActivityEvent[] => [
  { kind: "tool", id: `read-${file}`, parentId: null, phase: "started", name: "Read", input: { file_path: file } },
  { kind: "tool", id: `read-${file}`, parentId: null, phase: "completed", name: "tool", output: "ok" },
]

function settledTask(): ConversationDetail {
  return {
    id: "tsettled", title: "Settled", repo_path: "/synthetic/repo", worktree_path: "/synthetic/worktree",
    branch: "wisp/tsettled", base_commit: null, harness: "fake", model: null, effort: null, slot: 1,
    state: "done", state_detail: null, session_id: null, seq: 1, turn_count: 2, archived: false, mode: "worktree",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", messages: [],
    turns: [1, 2].map((n) => ({
      id: n, task_id: "tsettled", n, prompt: `prompt ${n}`, result: `answer ${n}`, status: "done", model: null,
      usage: null, attachments: [], started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z",
    })),
  } as ConversationDetail
}

describe("a settled turn's activity", () => {
  /** A settled log never changes: reading a long turn twice used to stream it twice. */
  it("is read once, and Show after Hide draws it from the cache", async () => {
    const streams: ReturnType<typeof createFakeSse>[] = []
    const transport = fakeDaemonTransport("settled-cache", {
      openEventStream: () => {
        const fake = createFakeSse()
        streams.push(fake)
        return fake.source
      },
    })
    render(<Conversation task={settledTask()} stream={initialStreamState} />, { wrapper: runtimeWrapper(transport) })
    const turn = () => screen.getByTestId("conversation-viewport").querySelector("[data-turn='1']") as HTMLElement
    const button = (name: RegExp) => [...turn().querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!

    fireEvent.click(button(/Show activity/))
    expect(streams).toHaveLength(1)
    act(() => {
      streams[0]!.emit("hello", { version: "test" })
      streams[0]!.emit("backlog", { turn: 1, prompt: "prompt 1", activity: read("/work/a.ts") })
      streams[0]!.emit("turn-end", { turn: 1, status: "done" })
    })
    await vi.waitFor(() => expect(turn()).toHaveTextContent("/work/a.ts"))

    fireEvent.click(button(/Hide activity/))
    expect(turn()).not.toHaveTextContent("/work/a.ts")
    fireEvent.click(button(/Show activity/))
    expect(turn()).toHaveTextContent("/work/a.ts")
    expect(streams).toHaveLength(1)
  })
})

describe("the live stream at a turn's end", () => {
  function follow(activity: ActivityEvent[]) {
    const fake = createFakeSse()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useLogStream("tlive", "activity", 0), {
      wrapper: runtimeWrapper(fakeDaemonTransport("seed", { openEventStream: () => fake.source }), client),
    })
    act(() => {
      fake.emit("hello", { version: "test" })
      fake.emit("backlog", { turn: 3, prompt: "go", activity })
      fake.emit("turn-end", { turn: 3, status: "done" })
    })
    return client.getQueryData<TurnActivity>(createConnectionQueryKeys("seed").activity("tlive", 3))
  }

  it("seeds the settled cache with the timeline it watched", () => {
    expect(follow(read("/work/b.ts"))?.items).toMatchObject([{ kind: "tool", id: "read-/work/b.ts", status: "completed" }])
  })

  it("seeds nothing when the viewer fell behind and the timeline has a gap", () => {
    const gap: ActivityEvent = { kind: "text", id: "capture-gap-4-9", parentId: null, text: "· live display skipped 6 activity records (900 bytes) while the viewer was behind" }
    expect(follow([{ kind: "text", id: "t1", parentId: null, text: "Reading" }, gap, ...read("/work/c.ts")])).toBeUndefined()
  })
})
