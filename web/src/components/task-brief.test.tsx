import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { BriefView } from "../../../shared/task-brief"
import { api } from "@/lib/api"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { BriefPane } from "./task-brief"
import { TaskPanel } from "./task-panel"

const CONNECTION = "brief-connection"

const TASK: ApiTask = {
  id: "tbr1ef",
  title: "Stop duplicate saves in the editor",
  repo_path: "/tmp/repo",
  worktree_path: "/tmp/wt",
  branch: "wisp/tbr1ef-saves",
  base_commit: "8f2a1c9",
  harness: "codex",
  model: "gpt-5.6-luna",
  effort: null,
  slot: 1,
  state: "done",
  state_detail: null,
  session_id: "s-1",
  seq: 4,
  turn_count: 4,
  archived: false,
  mode: "worktree",
  created_at: "2026-09-28T09:00:00Z",
  updated_at: "2026-09-28T10:00:00Z",
  briefEnabled: true,
}

const VIEW: BriefView = {
  enabled: true,
  generation: 1,
  archived: false,
  harness: "codex",
  supported: true,
  activation: "next-turn",
  report: {
    turn: { n: 4, status: "done", contextN: 1, endedAt: "2026-09-28T10:00:00Z" },
    revision: 1,
    savedAt: "2026-09-28T10:00:00Z",
    brief: {
      version: 1,
      goal: "Stop the editor saving twice.",
      outcome: "The toolbar path is fixed; autosave still races.",
      remaining: ["Guard autosave."],
      decision: {
        question: "Where should the guard live?",
        recommendation: "In the store, so every path gets it.",
        options: [
          { label: "In the store", gain: "Covers every path.", downside: "Shared module.", impact: "All editors.", effort: "Small." },
          { label: "In the button", gain: "Smallest.", downside: "Autosave still races.", impact: "Toolbar only.", effort: null },
        ],
      },
    },
  },
  latestEligibleTurn: { n: 4, status: "done", reported: true },
  latestTurn: { n: 4, status: "done", contextN: 1 },
  latestInput: {
    kind: "message", id: "m1", text: "Also check autosave, but keep the API.", truncated: false, length: 38,
    question: null, delivery: "steered", turnN: 4, at: "2026-09-28T09:55:00Z", legacy: false,
  },
  reasons: [],
}

interface Call { path: string; method: string; body: unknown }

function stub(brief: BriefView | null, features: Record<string, boolean> = { taskBriefs: true }, hasBriefs = true): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = path.endsWith("/api/harnesses")
      ? { harnesses: [{ name: "codex", hasBriefs }], features }
      : path.endsWith("/brief") ? brief
      : path.endsWith("/brief-settings") ? { enabled: !(brief?.enabled ?? false), activation: "next-turn", turnRunning: false }
      : path.endsWith("/diff") ? { diff: "", untracked: [], base: null, worktreeReason: null }
      : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }))
  return calls
}

const asked = (calls: Call[], suffix: string) => calls.some((c) => c.path.endsWith(suffix))

function mount(task: ApiTask, props: Partial<Parameters<typeof BriefPane>[0]> = {}) {
  const wrapper = runtimeWrapper(fakeDaemonTransport(CONNECTION, { request: api }))
  return render(<BriefPane task={task} {...props} />, { wrapper: wrapper as (props: { children: ReactNode }) => ReactNode })
}

afterEach(() => vi.unstubAllGlobals())

describe("the task brief tab", () => {
  it("a task with briefs off offers the switch and what it does, and asks for no report", async () => {
    const calls = stub({ ...VIEW, enabled: false })
    mount({ ...TASK, briefEnabled: false })
    const toggle = await screen.findByRole("switch", { name: "Task brief" })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(await screen.findByText(/the agent saves a short report/)).toBeInTheDocument()
    expect(asked(calls, "/brief")).toBe(false)
  })

  it("an older daemon without the feature shows no switch and asks for nothing", async () => {
    const calls = stub(VIEW, {})
    mount(TASK)
    await waitFor(() => expect(asked(calls, "/api/harnesses")).toBe(true))
    // let the features answer land before judging absence
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole("switch")).toBeNull()
    expect(asked(calls, "/brief")).toBe(false)
  })

  it("switching off writes the task's brief setting, and only that", async () => {
    const calls = stub(VIEW)
    mount(TASK)
    const toggle = await screen.findByRole("switch", { name: "Task brief" })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/brief-settings"))).toMatchObject({
      path: `/api/tasks/${TASK.id}/brief-settings`, method: "PUT", body: { enabled: false },
    }))
  })

  it("cannot switch on for a harness that cannot write briefs", async () => {
    stub({ ...VIEW, enabled: false, supported: false }, { taskBriefs: true }, false)
    mount({ ...TASK, briefEnabled: false })
    await waitFor(() => expect(screen.getByRole("switch", { name: "Task brief" })).toBeDisabled())
    expect(screen.getByText("codex can't write briefs through Wisp yet.")).toBeInTheDocument()
  })

  it("has no switch on an archived task, but still reads the report it has", async () => {
    stub(VIEW)
    mount({ ...TASK, archived: true })
    expect(await screen.findByText("Stop the editor saving twice.")).toBeInTheDocument()
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("shows your words first, then the agent's report under its own divider, with nothing to collapse", async () => {
    stub(VIEW)
    mount(TASK)
    const pane = await screen.findByRole("region", { name: "Task brief" })
    await within(pane).findByText("Stop the editor saving twice.")
    const text = pane.textContent ?? ""
    expect(text.indexOf("You asked")).toBeLessThan(text.indexOf("The agent's report"))
    expect(text.indexOf("The agent's report")).toBeLessThan(text.indexOf("Goal"))
    expect(within(pane).getByText("“Also check autosave, but keep the API.”")).toBeInTheDocument()
    expect(within(pane).getByText("Guard autosave.")).toBeInTheDocument()
    expect(within(pane).queryByRole("button", { expanded: true })).toBeNull()
  })

  it("keeps the switch outside the scrolling report, so a long brief cannot take it out of reach", async () => {
    stub(VIEW)
    mount(TASK)
    const toggle = await screen.findByRole("switch", { name: "Task brief" })
    const report = (await screen.findByText("Stop the editor saving twice.")).closest(".scroll-slim")
    expect(report).not.toBeNull()
    expect(report!.contains(toggle)).toBe(false)
    expect(toggle.closest(".scroll-slim")).toBeNull()
  })

  it("compares options in place, marking the recommended one", async () => {
    stub(VIEW)
    mount(TASK)
    const compare = await screen.findByRole("button", { name: "Compare 2 options" })
    expect(compare).not.toHaveAttribute("aria-controls")
    fireEvent.click(compare)
    expect(compare).toHaveAttribute("aria-expanded", "true")
    const options = document.getElementById(compare.getAttribute("aria-controls")!)!
    expect(within(options).getByText("In the store").parentElement).toHaveTextContent("Recommended")
    expect(within(options).getByText("In the button").parentElement).not.toHaveTextContent("Recommended")
    expect(within(options).getByText("Not assessed")).toBeInTheDocument()
  })

  it("Show in conversation hands the words to find-in-task, naming their turn", async () => {
    stub(VIEW)
    mount(TASK)
    fireEvent.click(await screen.findByRole("button", { name: "Show in conversation" }))
    expect(uiIntentsFor(CONNECTION).findRequest()).toMatchObject({ query: "Also check autosave, but keep the API.", turn: 4 })
  })

  it("on touch, Show in conversation first brings the chat forward, then finds the words there", async () => {
    stub(VIEW)
    const showChat = vi.fn()
    mount(TASK, { touch: true, onShowConversation: showChat })
    const before = uiIntentsFor(CONNECTION).findRequest()?.seq ?? 0
    fireEvent.click(await screen.findByRole("button", { name: "Show in conversation" }))
    expect(showChat).toHaveBeenCalledOnce()
    await waitFor(() => expect(uiIntentsFor(CONNECTION).findRequest()?.seq ?? 0).toBeGreaterThan(before))
    expect(uiIntentsFor(CONNECTION).findRequest()).toMatchObject({ query: "Also check autosave, but keep the API.", turn: 4 })
  })

  it("with no report yet it is one honest line", async () => {
    stub({ ...VIEW, report: null, latestEligibleTurn: null, reasons: ["no-report"] })
    mount(TASK)
    expect(await screen.findByText("Starts with the next turn.")).toBeInTheDocument()
    expect(screen.queryByText("Goal")).toBeNull()
  })

  it("stays mounted but hidden when another tab shows", async () => {
    stub(VIEW)
    mount(TASK, { hidden: true })
    const pane = (await screen.findByText("Stop the editor saving twice.", {}, { timeout: 2000 })).closest("[aria-hidden]")
    expect(pane).toHaveAttribute("aria-hidden", "true")
  })
})

const ago = "2026-09-28T10:00:00Z"

describe("the task panel", () => {
  const panel = () => {
    const wrapper = runtimeWrapper(fakeDaemonTransport(CONNECTION, { request: api }))
    return render(<TaskPanel task={TASK} taskId={TASK.id} archived={false} />, { wrapper: wrapper as (props: { children: ReactNode }) => ReactNode })
  }

  it("opens on the Brief, first in the strip", async () => {
    stub(VIEW)
    panel()
    const tabs = await screen.findByRole("tablist", { name: "Task panel" })
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Brief", "Changes0"])
    expect(within(tabs).getByRole("tab", { name: "Brief" })).toHaveAttribute("aria-selected", "true")
    expect((await screen.findByText("Stop the editor saving twice.")).closest("[aria-hidden='true']")).toBeNull()
  })

  it("keeps the report mounted while Changes shows, and comes back to it", async () => {
    stub(VIEW)
    panel()
    const report = await screen.findByText("Stop the editor saving twice.")
    fireEvent.click(screen.getByRole("tab", { name: /Changes/ }))
    expect(report.closest("[aria-hidden='true']")).not.toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Brief" }))
    expect(report.closest("[aria-hidden='true']")).toBeNull()
  })

  it("puts the workflow count on Workflows only, never on the Brief, with no React key warnings", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const workflow = {
      id: "wfixture", taskId: TASK.id, type: "heartbeat", version: "1", params: {}, state: "active",
      reason: "Waiting", revision: 1, contextN: 1, wakeCount: 0, checkCount: 0,
      lastCheckedAt: null, nextCheckAt: null, expiresAt: "2026-12-01T00:00:00Z", createdAt: ago, updatedAt: ago,
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path.endsWith("/api/harnesses") ? { harnesses: [], features: { taskBriefs: true, taskWorkflows: true } }
        : path.endsWith("/brief") ? VIEW
        : path.endsWith("/diff") ? { diff: "", untracked: [], base: null, worktreeReason: null }
        : path.endsWith("/workflows") ? [workflow]
        : []
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    }))
    panel()
    const tabs = await screen.findByRole("tablist", { name: "Task panel" })
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /Workflows/ })).toHaveTextContent("1"))
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Brief", "Changes0", "Workflows1"])
    // sibling panes with one key make React drop a fiber when the task changes
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("same key"))).toEqual([])
    errors.mockRestore()
  })

  it("paints nothing until it knows which tabs the daemon has, so it never opens on Changes and jumps", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
    panel()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole("tablist", { name: "Task panel" })).toBeNull()
    expect(screen.queryByText("Changes")).toBeNull()
  })

  it("opens on Changes, with no strip, when the daemon has no briefs", async () => {
    const calls = stub(VIEW, {})
    panel()
    await waitFor(() => expect(asked(calls, "/api/harnesses")).toBe(true))
    await waitFor(() => expect(screen.queryByRole("tablist", { name: "Task panel" })).toBeNull())
    expect(screen.queryByRole("region", { name: "Task brief" })).toBeNull()
  })
})
