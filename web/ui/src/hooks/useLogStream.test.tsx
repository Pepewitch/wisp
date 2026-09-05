import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useLogStream } from "./useLogStream"
import { createFakeSse } from "@/test/fake-sse"

describe("useLogStream", () => {
  it("requests canonical activity and updates one stable subagent node", async () => {
    const fake = createFakeSse()
    let url = ""
    const factory = (next: string) => {
      url = next
      return fake.source
    }
    const { result, unmount } = renderHook(() => useLogStream("task-1", "activity", 0, factory))
    expect(url).toBe("/api/tasks/task-1/log/stream?format=activity")

    act(() => {
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
})
