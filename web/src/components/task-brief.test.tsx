import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BriefView } from "../../../shared/task-brief"
import { api } from "@/lib/api"
import { resetBriefOpenForTests } from "@/lib/brief-open"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { BriefedConversation } from "./task-brief"

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

function stub(brief: BriefView | null, features: Record<string, boolean> = { taskBriefs: true }): string[] {
  const paths: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    paths.push(path)
    const body = path.endsWith("/api/harnesses")
      ? { harnesses: [], features }
      : path.endsWith("/brief") ? brief : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }))
  return paths
}

function mount(task: ApiTask, touch = false) {
  const wrapper = runtimeWrapper(fakeDaemonTransport(CONNECTION, { request: api }))
  return render(
    <BriefedConversation task={task} touch={touch}>
      <div data-testid="conversation">the transcript</div>
    </BriefedConversation>,
    { wrapper: wrapper as (props: { children: ReactNode }) => ReactNode },
  )
}

beforeEach(() => resetBriefOpenForTests())
afterEach(() => vi.unstubAllGlobals())

describe("the task brief band", () => {
  it("a task with briefs off shows nothing and asks for nothing", async () => {
    const paths = stub(VIEW)
    mount({ ...TASK, briefEnabled: false })
    await waitFor(() => expect(paths.some((p) => p.endsWith("/api/harnesses"))).toBe(true))
    expect(screen.queryByRole("region", { name: "Task brief" })).toBeNull()
    expect(paths.some((p) => p.endsWith("/brief"))).toBe(false)
    expect(screen.getByTestId("conversation")).toBeVisible()
  })

  it("an older daemon without the feature shows nothing", async () => {
    const paths = stub(VIEW, {})
    mount(TASK)
    await waitFor(() => expect(paths.some((p) => p.endsWith("/api/harnesses"))).toBe(true))
    // let the features answer land before judging absence
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole("region", { name: "Task brief" })).toBeNull()
    expect(paths.some((p) => p.endsWith("/brief"))).toBe(false)
  })

  it("opens on a pointer with your words first, then the agent's report under its own divider", async () => {
    stub(VIEW)
    mount(TASK)
    const band = await screen.findByRole("region", { name: "Task brief" })
    expect(within(band).getByRole("button", { expanded: true })).toHaveTextContent("Brief")
    const text = band.textContent ?? ""
    expect(text.indexOf("You asked")).toBeLessThan(text.indexOf("The agent's report"))
    expect(text.indexOf("The agent's report")).toBeLessThan(text.indexOf("Goal"))
    expect(within(band).getByText("“Also check autosave, but keep the API.”")).toBeInTheDocument()
    expect(within(band).getByText("Stop the editor saving twice.")).toBeInTheDocument()
    expect(within(band).getByText("Guard autosave.")).toBeInTheDocument()
  })

  it("collapses to one line, remembers that, and never writes to the daemon", async () => {
    const paths = stub(VIEW)
    const { unmount } = mount(TASK)
    const band = await screen.findByRole("region", { name: "Task brief" })
    const toggle = within(band).getByRole("button", { expanded: true })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(band).queryByText("Goal")).toBeNull()
    expect(toggle).toHaveTextContent("Decision · Where should the guard live?")
    unmount()
    mount(TASK)
    expect(await screen.findByRole("button", { expanded: false })).toBeInTheDocument()
    expect(paths.every((p) => !p.includes("brief-settings"))).toBe(true)
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

  it("on touch, Show in conversation first gives the transcript back, then finds the words there", async () => {
    stub(VIEW)
    mount(TASK, true)
    fireEvent.click(await screen.findByRole("button", { expanded: false }))
    expect(screen.getByTestId("conversation")).not.toBeVisible()
    const before = uiIntentsFor(CONNECTION).findRequest()?.seq ?? 0
    fireEvent.click(screen.getByRole("button", { name: "Show in conversation" }))
    expect(screen.getByTestId("conversation")).toBeVisible()
    await waitFor(() => expect(uiIntentsFor(CONNECTION).findRequest()?.seq ?? 0).toBeGreaterThan(before))
    expect(uiIntentsFor(CONNECTION).findRequest()).toMatchObject({ query: "Also check autosave, but keep the API.", turn: 4 })
  })

  it("a find from elsewhere (the task menu, ⌘F) closes a touch takeover so the transcript can answer it", async () => {
    stub(VIEW)
    mount(TASK, true)
    fireEvent.click(await screen.findByRole("button", { expanded: false }))
    expect(screen.getByTestId("conversation")).not.toBeVisible()
    act(() => uiIntentsFor(CONNECTION).openFind("anything", null))
    await waitFor(() => expect(screen.getByTestId("conversation")).toBeVisible())
  })

  it("on touch it starts closed; open, it replaces the transcript instead of squeezing it", async () => {
    stub(VIEW)
    mount(TASK, true)
    const toggle = await screen.findByRole("button", { expanded: false })
    expect(screen.getByTestId("conversation")).toBeVisible()
    fireEvent.click(toggle)
    expect(screen.getByTestId("conversation")).not.toBeVisible()
  })

  it("with no report yet it is one honest line", async () => {
    stub({ ...VIEW, report: null, latestEligibleTurn: null, reasons: ["no-report"] })
    mount(TASK)
    const band = await screen.findByRole("region", { name: "Task brief" })
    expect(band).toHaveTextContent("Starts with the next turn.")
    expect(within(band).queryByRole("button")).toBeNull()
  })
})
