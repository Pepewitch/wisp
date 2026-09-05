import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApiTask } from "@/lib/types"

import { SteerBox } from "./steer-box"

afterEach(() => vi.unstubAllGlobals())

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const task = (state: ApiTask["state"] = "running"): ApiTask =>
  ({
    id: "tk9zdy",
    title: "steer",
    harness: "codex",
    model: "gpt-5",
    state,
    state_detail: null,
    archived: false,
    turn_count: 1,
    seq: 4,
    branch: "wisp/tk9zdy-steer",
    worktree_path: "/tmp/wt",
    repo_path: "/tmp/repo",
  }) as ApiTask

describe("the running-turn composer control", () => {
  it.each(["running", "stuck"] as const)(
    "is a clickable stop button while a %s task's draft is empty",
    async (state) => {
      const onInterrupt = vi.fn()
      mount(<SteerBox task={task(state)} onInterrupt={onInterrupt} onSend={() => {}} />)

      const stop = screen.getByRole("button", { name: "Stop turn" })
      expect(stop).toBeEnabled()
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull()

      fireEvent.click(stop)
      await waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce())
    },
  )

  it.each(["click", "Enter"] as const)(
    "sends without interrupting the running turn on %s",
    async (action) => {
      const order: string[] = []
      const onInterrupt = vi.fn(async () => {
        order.push("interrupt")
      })
      const onSend = vi.fn(async () => {
        order.push("send")
      })
      mount(<SteerBox task={task()} onInterrupt={onInterrupt} onSend={onSend} />)

      const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
      fireEvent.change(box, { target: { value: "change direction" } })
      const steer = screen.getByRole("button", { name: "Send safely" })
      expect(steer).toBeEnabled()

      if (action === "click") fireEvent.click(steer)
      else fireEvent.keyDown(box, { key: "Enter" })

      await waitFor(() => expect(onSend).toHaveBeenCalledWith("change direction", undefined))
      expect(onInterrupt).not.toHaveBeenCalled()
      expect(order).toEqual(["send"])
      await waitFor(() => expect(box).toHaveValue(""))
    },
  )

  it("keeps the correction when the send is refused", async () => {
    const onInterrupt = vi.fn()
    const onSend = vi.fn(async () => {
      throw new Error("offline")
    })
    mount(<SteerBox task={task()} onInterrupt={onInterrupt} onSend={onSend} />)

    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.change(box, { target: { value: "do this instead" } })
    fireEvent.click(screen.getByRole("button", { name: "Send safely" }))

    expect(await screen.findByTestId("steer-note")).toHaveTextContent("Could not reach the daemon")
    expect(onSend).toHaveBeenCalledOnce()
    expect(onInterrupt).not.toHaveBeenCalled()
    expect(box).toHaveValue("do this instead")
  })

  it("reuses the stable message id when the same failed request is retried", async () => {
    const bodies: Array<{ clientMessageId: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as { clientMessageId: string })
        if (bodies.length === 1) {
          return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ disposition: "queued-next", message: {}, turn_count: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
    )
    mount(<SteerBox task={task()} />)

    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.change(box, { target: { value: "retry this safely" } })
    fireEvent.click(screen.getByRole("button", { name: "Send safely" }))
    await screen.findByText("temporarily unavailable")
    fireEvent.click(screen.getByRole("button", { name: "Send safely" }))

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]!.clientMessageId).toBe(bodies[0]!.clientMessageId)
  })
})
