import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { DaemonTransport } from "@/lib/transport"
import type { TaskMessage } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { QueuedMessage } from "./queued-message"

const message = (overrides: Partial<TaskMessage> = {}): TaskMessage => ({
  id: "m-held",
  task_id: "tqueue",
  text: "After this, add tests",
  status: "queued",
  delivery: null,
  turn_n: null,
  delivery_uncertain: false,
  deferred: true,
  attachments: [],
  created_at: "2026-09-03T00:00:01Z",
  updated_at: "2026-09-03T00:00:01Z",
  ...overrides,
})

function mount(item: TaskMessage, steerDelivery: boolean) {
  const request = vi.fn<DaemonTransport["request"]>(async <T,>(path: string) =>
    (path === "/api/harnesses" ? { harnesses: [], features: { steerDelivery } } : { disposition: "steered" }) as T)
  render(<QueuedMessage taskId="tqueue" message={item} archived={false} assetsRemoved={false} />, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: request as DaemonTransport["request"] })),
  })
  return request
}

describe("a queued message", () => {
  it("says it is held, and sends now through its own route", async () => {
    const request = mount(message(), true)

    expect(screen.getByText("held for the next turn")).toBeInTheDocument()
    fireEvent.click(await screen.findByRole("button", { name: "Send queued message now" }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/tasks/tqueue/messages/m-held/send-now", { method: "POST" }))
  })

  it("offers no send-now to a daemon without it, or for a workflow's instruction", async () => {
    const request = mount(message({ deferred: false }), false)
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/harnesses"))
    expect(screen.getByText("queued for the next turn")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Send queued message now" })).toBeNull()
  })

  it("leaves a workflow's generated instruction to its workflow", async () => {
    const request = mount(message({ workflow_id: "wflow" }), true)
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/harnesses"))
    expect(screen.queryByRole("button", { name: "Send queued message now" })).toBeNull()
  })
})
