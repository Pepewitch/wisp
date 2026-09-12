import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { ResumeHint } from "./resume-hint"
import { SteerBox } from "./steer-box"

/**
 * The resume hint: after a turn ends, the right edge above the composer names
 * the stored session — one short `session: <id>` line — while the copy button
 * carries the full command that continues it outside Wisp. That command is the
 * daemon's own answer (GET /attach, built from the adapter's attach template),
 * never something the UI reconstructs from the harness name.
 */

const task = (over: Partial<ApiTask> = {}): ApiTask =>
  ({
    id: "tk9zdy",
    title: "steer",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/wt",
    branch: "wisp/tk9zdy-steer",
    base_commit: "8f2a1c9",
    harness: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: "s-1",
    seq: 4,
    turn_count: 3,
    archived: false,
    mode: "worktree",
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    ...over,
  }) as ApiTask

interface Call {
  path: string
  method: string
}
function stubApi(handler: (path: string, method: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      calls.push({ path, method })
      const { status, body } = handler(path, method)
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
  return calls
}

function mount(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api })),
  })
}

const writeText = vi.fn(async () => {})
afterEach(() => {
  writeText.mockClear()
  vi.unstubAllGlobals()
})

describe("ResumeHint", () => {
  it("after a turn ends, the right edge above the composer names the session, not the command", async () => {
    stubApi(() => ({ status: 200, body: { argv: ["claude", "--resume", "s-1"], cwd: "/tmp/wt", message: null } }))
    mount(<ResumeHint task={task()} />)

    const hint = await screen.findByTestId("resume-hint")
    expect(hint).toHaveTextContent("session: s-1")
    // the full working line lives in the hover title, not the display
    expect(hint.querySelector("span")).toHaveAttribute("title", "cd /tmp/wt && claude --resume s-1")
    // a long id truncates from the left, keeping its identifying tail
    expect(hint.querySelector("span")).toHaveAttribute("dir", "rtl")
  })

  it("the copy speaks every harness's own shape, because the daemon assembled it", async () => {
    stubApi(() => ({ status: 200, body: { argv: ["codex", "resume", "s-1"], cwd: null, message: null } }))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    mount(<ResumeHint task={task({ harness: "codex" })} />)

    // the display is harness-independent
    expect(await screen.findByTestId("resume-hint")).toHaveTextContent("session: s-1")
    fireEvent.click(screen.getByRole("button", { name: "Copy the resume command" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("codex resume s-1"))
  })

  it("the copy carries the whole working line, not the truncated display", async () => {
    stubApi(() => ({ status: 200, body: { argv: ["claude", "--resume", "s-1"], cwd: "/tmp/wt", message: null } }))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    mount(<ResumeHint task={task()} />)

    fireEvent.click(await screen.findByRole("button", { name: "Copy the resume command" }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("cd /tmp/wt && claude --resume s-1"),
    )
  })

  it("a turn that still owes the harness nothing yet — needs-input — is ended too", async () => {
    stubApi(() => ({ status: 200, body: { argv: ["claude", "--resume", "s-1"], cwd: null, message: null } }))
    mount(<ResumeHint task={task({ state: "needs-input" })} />)

    expect(await screen.findByTestId("resume-hint")).toHaveTextContent("session: s-1")
  })

  it("renders nothing before the first turn gives the task a session", () => {
    const calls = stubApi(() => ({ status: 200, body: { argv: null, cwd: null, message: null } }))
    mount(<ResumeHint task={task({ session_id: null })} />)

    expect(screen.queryByTestId("resume-hint")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("renders nothing while a turn is running — the command is not paste-ready yet", () => {
    const calls = stubApi(() => ({ status: 200, body: { argv: null, cwd: null, message: null } }))
    mount(<ResumeHint task={task({ state: "running" })} />)

    expect(screen.queryByTestId("resume-hint")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("renders nothing on an archived task — its worktree is gone", () => {
    const calls = stubApi(() => ({ status: 200, body: { argv: null, cwd: null, message: null } }))
    mount(<ResumeHint task={task({ archived: true })} />)

    expect(screen.queryByTestId("resume-hint")).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it("a harness with no attach command renders nothing rather than a guess", async () => {
    stubApi(() => ({ status: 200, body: { argv: null, cwd: null, message: "no known attach command" } }))
    mount(<ResumeHint task={task({ harness: "mystery" })} />)

    await waitFor(() => expect(screen.queryByTestId("resume-hint")).toBeNull())
  })

  it("sits inside the steer box, directly above the composer", async () => {
    stubApi((path) =>
      path.endsWith("/attach")
        ? { status: 200, body: { argv: ["claude", "--resume", "s-1"], cwd: "/tmp/wt", message: null } }
        : { status: 404, body: { error: "unstubbed" } },
    )
    mount(<SteerBox task={task()} onSend={async () => {}} />)

    const hint = await screen.findByTestId("resume-hint")
    const composer = screen.getByTestId("steer-composer")
    expect(
      hint.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
