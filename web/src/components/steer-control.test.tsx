import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { sameOriginWebTransport } from "@/lib/web-transport"
import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { StateDot } from "./primitives"
import { stateWord } from "@/lib/state"

import { SteerBox } from "./steer-box"

afterEach(() => vi.unstubAllGlobals())

function mount(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api })),
  })
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
  it.each([
    ["browser", 200], ["desktop", 200], ["browser", 409], ["desktop", 409],
  ] as const)("waits for confirmed Stop and shows a refusal on %s (HTTP %s)", async (runtime, status) => {
    let answer!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { answer = resolve }))
    vi.stubGlobal("fetch", fetcher)
    const transport = runtime === "browser"
      ? sameOriginWebTransport
      : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
    render(<SteerBox task={task()} onSend={() => {}} />, { wrapper: runtimeWrapper(transport) })
    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }))
    expect(await screen.findByTestId("steer-note")).toHaveTextContent("Stopping…")
    expect(screen.queryByText("Stopped")).toBeNull()
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0]?.[0]).toBe(runtime === "browser"
      ? "/api/tasks/tk9zdy/interrupt"
      : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1/api/tasks/tk9zdy/interrupt")
    fireEvent.change(screen.getByPlaceholderText("Ask for changes, or / for commands"), { target: { value: "next work" } })
    expect(screen.getByRole("button", { name: "Send safely" })).toBeDisabled()
    answer(new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "Could not fully stop turn: retry Stop" }), { status }))
    await waitFor(() => expect(screen.getByTestId("steer-note")).toHaveTextContent(
      status === 200 ? "Stopped" : "Could not fully stop turn: retry Stop",
    ))
    if (status === 409) expect(screen.queryByText("Stopped")).toBeNull()
  })

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

describe("the composer control bar answers its own width", () => {
  /** jsdom evaluates no container query, so both arrangements are in the DOM. */
  const shown = (text: string) =>
    screen.getAllByText(text).map((node) => node.className)

  it("marks the bar a container rather than reading the window", () => {
    const { container } = mount(<SteerBox task={task("done")} />)

    // Desktop's zoom shrinks this pane in CSS pixels without touching the
    // window, so a media query would never fire for it
    expect(container.querySelector('[class~="@container"]')).not.toBeNull()
  })

  it("yields harness and model at the first step, where the task header still says them", () => {
    mount(<SteerBox task={task("done")} />)

    expect(screen.getByText("codex").closest("span.hidden")?.className).toContain("@lg:flex")
  })

  it("gives the running note its own line until the bar is wide enough to inline it", () => {
    mount(<SteerBox task={task()} />)

    const notes = shown("running · send won't interrupt")
    expect(notes).toHaveLength(2)
    // the stacked one disappears once the row is wide enough for the inline one
    expect(notes.some((c) => c.includes("@2xl:hidden"))).toBe(true)
    expect(notes.some((c) => c.includes("@2xl:block") && c.includes("whitespace-nowrap"))).toBe(true)
  })

  it("keeps the keyboard hint for the wide arrangement alone", () => {
    mount(<SteerBox task={task("done")} />)

    expect(screen.getByTitle("Enter sends · Shift+Enter for a new line").className).toContain("@2xl:block")
  })
})


describe("completed work with a background process", () => {
  it.each(["browser", "desktop"] as const)("keeps Stop available and steering non-destructive through %s", async (runtime) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetcher)
    const transport = runtime === "browser" ? sameOriginWebTransport
      : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
    const backgroundTask: ApiTask = { ...task("done"), background: { state: "running", groups: 1 } }
    const send = vi.fn()
    const view = render(<><StateDot state={backgroundTask.state} background={backgroundTask.background} />
      <SteerBox task={backgroundTask} onSend={send} /></>, { wrapper: runtimeWrapper(transport) })
    expect(screen.getByRole("img", { name: "Done · Background work running" })).toHaveClass("border-state-background")
    expect(stateWord(backgroundTask)).toBe("Done · Background work running")
    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.change(box, { target: { value: "continue working" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(send).toHaveBeenCalledWith("continue working", undefined))
    expect(fetcher).not.toHaveBeenCalled()
    await waitFor(() => expect(box).toHaveValue(""))
    fireEvent.click(screen.getByRole("button", { name: "Stop background work" }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0]?.[0]).toBe(runtime === "browser" ? "/api/tasks/tk9zdy/interrupt"
      : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1/api/tasks/tk9zdy/interrupt")
    await waitFor(() => expect(screen.getByTestId("steer-note")).toHaveTextContent("Stopped"))
    view.rerender(<><StateDot state="done" background={{ state: "none", groups: 0 }} />
      <SteerBox task={{ ...backgroundTask, background: { state: "none", groups: 0 } }} onSend={send} /></>)
    expect(screen.getByRole("img", { name: "Done" })).toHaveClass("bg-state-done")
    expect(screen.queryByRole("button", { name: "Stop background work" })).toBeNull()
  })

  it.each(["unknown", "stopping"] as const)("uses an amber square and an explicit label for %s background work", (state) => {
    render(<StateDot state="done" background={{ state, groups: 1 }} />)
    const dot = screen.getByRole("img")
    expect(dot).toHaveClass("rounded-[1px]", "bg-state-stuck")
    expect(dot).not.toHaveClass("bg-state-done")
    expect(dot).toHaveAccessibleName(state === "unknown" ? "Done · Background status unknown" : "Done · Stopping background work")
  })
})
