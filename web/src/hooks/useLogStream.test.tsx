import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { connectionStore } from "@/lib/conn"
import { useLogStream } from "./useLogStream"
import { createFakeSse } from "@/test/fake-sse"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

describe("useLogStream", () => {
  it("requests canonical activity and updates one stable subagent node", async () => {
    const fake = createFakeSse()
    let url = ""
    const transport = fakeDaemonTransport("connection-one", {
      openEventStream: (next) => {
        url = next
        return fake.source
      },
    })
    const { result, unmount } = renderHook(() => useLogStream("task-1", "activity", 0), {
      wrapper: runtimeWrapper(transport),
    })
    expect(url).toBe("/api/tasks/task-1/log/stream?format=activity")

    act(() => {
      fake.emit("hello", { version: "0.5.7-test" })
      fake.emit("backlog", {
        turn: 1,
        prompt: "delegate",
        activity: [{
          kind: "subagent",
          id: "call-1",
          parentId: null,
          phase: "started",
          status: "running",
          title: "Inspect UI",
        }],
      })
    })
    await waitFor(() => expect(result.current.currentTurn).toBe(1))

    act(() => {
      fake.emit("append", {
        turn: 1,
        activity: [{
          kind: "subagent",
          id: "call-1",
          parentId: null,
          phase: "completed",
          status: "failed",
          error: "Child exited",
        }],
      })
    })
    await waitFor(() => {
      const block = result.current.blocks.find((item) => item.kind === "activity")
      expect(block).toMatchObject({
        kind: "activity",
        items: [{ id: "call-1", title: "Inspect UI", status: "failed", error: "Child exited" }],
      })
    })

    unmount()
    expect(fake.isClosed()).toBe(true)
  })

  it("ignores frames and health changes from a replaced task stream", async () => {
    const first = createFakeSse()
    const second = createFakeSse()
    const streams = [first, second]
    const connectionId = "connection-replaced-log"
    const transport = fakeDaemonTransport(connectionId, {
      openEventStream: () => streams.shift()!.source,
    })
    const { result, rerender } = renderHook(
      ({ taskId }) => useLogStream(taskId, "activity", 0),
      {
        initialProps: { taskId: "task-one" },
        wrapper: runtimeWrapper(transport),
      },
    )

    rerender({ taskId: "task-two" })
    expect(first.isClosed()).toBe(true)
    act(() => {
      second.emit("backlog", { turn: 2, prompt: "second", activity: [] })
    })
    await waitFor(() => expect(result.current.currentTurn).toBe(2))

    act(() => {
      first.emit("backlog", { turn: 1, prompt: "stale", activity: [] })
      first.fail()
    })
    expect(result.current.currentTurn).toBe(2)
    expect(connectionStore(connectionId).isLive()).toBe(true)
  })

  it("closes malformed frames as versioned protocol errors without retrying them", async () => {
    const fake = createFakeSse()
    const ensureReady = vi.fn(async () => undefined)
    const connectionId = "connection-malformed-log"
    const transport = fakeDaemonTransport(connectionId, {
      ensureReady,
      openEventStream: () => fake.source,
    })
    const { result } = renderHook(() => useLogStream("task-1", "raw", 0), {
      wrapper: runtimeWrapper(transport),
    })

    act(() => {
      fake.emit("hello", { version: "0.5.7-test" })
      fake.emitRaw("backlog", "{")
    })

    await waitFor(() =>
      expect(result.current.note).toContain(
        'Log stream protocol error in "backlog" from daemon 0.5.7-test: invalid JSON',
      ),
    )
    expect(fake.isClosed()).toBe(true)
    expect(connectionStore(connectionId).isLive()).toBe(false)
    expect(ensureReady).not.toHaveBeenCalled()
  })
})
