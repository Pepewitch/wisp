import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDesktopTransport } from "@/lib/desktop-transport"
import { sameOriginWebTransport } from "@/lib/web-transport"
import type { ApiTask, HarnessInfo, TurnInput } from "@/lib/types"
import { runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"

afterEach(() => vi.unstubAllGlobals())

const input = (mode: TurnInput["mode"], model = "gpt-5"): TurnInput => ({
  mode,
  context_n: 1,
  harness: "codex",
  model,
  effort: null,
  fast: false,
})

const task = (turnInput: TurnInput | null | undefined, state: ApiTask["state"] = "running"): ApiTask =>
  ({
    id: "tk9zdy",
    title: "queue",
    harness: "codex",
    model: "gpt-5",
    effort: null,
    fast: false,
    context_n: 1,
    state,
    state_detail: null,
    archived: false,
    turn_count: 1,
    seq: 4,
    branch: "wisp/tk9zdy-queue",
    worktree_path: "/tmp/wt",
    repo_path: "/tmp/repo",
    ...(turnInput !== undefined ? { turn_input: turnInput } : {}),
  }) as ApiTask

const harnesses: HarnessInfo[] = [
  {
    name: "codex",
    hasModel: true,
    hasEffort: false,
    hasImage: true,
    defaults: { model: "gpt-5" },
    models: { list: ["gpt-5", "gpt-6"], defaultModel: "gpt-5", probedAt: "2026-09-09T00:00:00.000Z" },
  },
]

type Sent = { url: string; body: Record<string, unknown> }

function stubSend(response: Record<string, unknown> = { disposition: "queued-next", message: {}, turn_count: 1 }): Sent[] {
  const sends: Sent[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/send")) sends.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
    }),
  )
  return sends
}

const type = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText("Ask for changes, or / for commands"), { target: { value: text } })

describe("the queue toggle", () => {
  it.each(["browser", "desktop"] as const)("holds one send for the next turn, then turns itself off (%s)", async (runtime) => {
    const sends = stubSend()
    const transport = runtime === "browser"
      ? sameOriginWebTransport
      : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
    render(<SteerBox task={task(input("steer"))} canChooseDelivery />, { wrapper: runtimeWrapper(transport) })

    const toggle = screen.getByRole("button", { name: "Queue for the next turn", pressed: false })
    expect(screen.getByText("running · send steers this turn")).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("running · send waits for the next turn")).toBeInTheDocument()

    type("after this turn")
    // the send button keeps its arrow and names what it will do
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }))
    await waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]!.url).toBe(runtime === "browser"
      ? "/api/tasks/tk9zdy/send"
      : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1/api/tasks/tk9zdy/send")
    expect(sends[0]!.body).toMatchObject({ message: "after this turn", when: "next-turn" })
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue for the next turn", pressed: false })).toBeInTheDocument())

    type("steer this one")
    fireEvent.click(screen.getByRole("button", { name: "Send to the running turn" }))
    await waitFor(() => expect(sends).toHaveLength(2))
    expect(sends[1]!.body).toMatchObject({ message: "steer this one", when: "now" })
  })

  it("is not offered while idle, or by a daemon that would ignore it", () => {
    const { rerender } = render(<SteerBox task={task(null, "done")} canChooseDelivery />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    expect(screen.queryByRole("button", { name: "Queue for the next turn" })).toBeNull()

    rerender(<SteerBox task={task(undefined)} canChooseDelivery />)
    expect(screen.queryByRole("button", { name: "Queue for the next turn" })).toBeNull()
    expect(screen.getByText("running · send won't interrupt")).toBeInTheDocument()

    rerender(<SteerBox task={task(input("steer"))} />)
    type("x")
    expect(screen.queryByRole("button", { name: "Queue for the next turn" })).toBeNull()
    expect(screen.getByRole("button", { name: "Send safely" })).toBeInTheDocument()
  })

  it("an older daemon's send carries no when", async () => {
    const sends = stubSend()
    render(<SteerBox task={task(undefined)} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    type("plain steer")
    fireEvent.click(screen.getByRole("button", { name: "Send safely" }))
    await waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]!.body).not.toHaveProperty("when")
  })

  // `now` may stop a turn, so only a send whose note said so carries it
  it.each([
    ["an idle task", task(null, "done"), "Send"],
    ["a running task with no turn to aim at", task(null), "Send safely"],
  ] as const)("a send from %s carries no when", async (_case, shownTask, label) => {
    const sends = stubSend()
    render(<SteerBox task={shownTask} canChooseDelivery />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    type("hello")
    fireEvent.click(screen.getByRole("button", { name: label }))
    await waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]!.body).not.toHaveProperty("when")
  })

  it("a retry keeps the delivery the first attempt asked for", async () => {
    const sends: Sent[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/send")) sends.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response(JSON.stringify({ error: "network hiccup" }), { status: 500, headers: { "content-type": "application/json" } })
      }),
    )
    render(<SteerBox task={task(input("steer"))} canChooseDelivery />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    fireEvent.click(screen.getByRole("button", { name: "Queue for the next turn" }))
    type("after this turn")
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }))
    await waitFor(() => expect(sends).toHaveLength(1))
    await screen.findByTestId("steer-note")

    fireEvent.click(screen.getByRole("button", { name: "Queue for the next turn", pressed: true }))
    fireEvent.click(screen.getByRole("button", { name: "Send to the running turn" }))
    await waitFor(() => expect(sends).toHaveLength(2))
    expect(sends[1]!.body).toMatchObject({ clientMessageId: sends[0]!.body.clientMessageId, when: "next-turn" })
  })
})

describe("the running note says what send will do", () => {
  it.each([
    [input("steer"), "running · send steers this turn", "Send to the running turn", false],
    [input("wait"), "finishing · send starts the next turn", "Send for the next turn", false],
    [input("interrupt"), "running · send stops this turn, then sends", "Stop and send", true],
    // a different agent than the running turn's can only start a new turn
    [input("steer", "gpt-6"), "running · send stops this turn, then sends", "Stop and send", true],
  ] as const)("%o", (turnInput, note, label, warn) => {
    render(<SteerBox task={task(turnInput)} canChooseDelivery />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    type("x")
    const shown = screen.getByText(note)
    expect(shown.className.includes("text-state-needs-input")).toBe(warn)
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
  })

  it("reads the picker's agent: the running turn's own model steers", () => {
    render(<SteerBox task={task(input("steer"))} harnesses={harnesses} canSwitchAgent canChooseDelivery />, {
      wrapper: runtimeWrapper(sameOriginWebTransport),
    })
    expect(screen.getByText("running · send steers this turn")).toBeInTheDocument()
  })

  it("reports a send that had to stop the turn", async () => {
    stubSend({ disposition: "started", interrupted: true, message: { turn_n: 2, delivery_uncertain: false }, turn_count: 2 })
    render(<SteerBox task={task(input("interrupt"))} canChooseDelivery />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
    type("new direction")
    fireEvent.click(screen.getByRole("button", { name: "Stop and send" }))
    expect(await screen.findByTestId("steer-note")).toHaveTextContent("stopped the turn and started turn 2")
  })
})
