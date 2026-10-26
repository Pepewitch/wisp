import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AutopilotStatus } from "../../../shared/autopilot"
import { PR_SPECIMEN } from "@/components/gallery-fixtures"
import { resetSummaryCardStore, usePaneFitsCard, useSummaryFolded } from "@/hooks/useSummaryCard"
import { ToolPanelContext, type ToolPanelControls } from "@/hooks/useToolPanel"
import { api } from "@/lib/api"
import { createConnectionQueryKeys } from "@/lib/query"
import type { ApiTask, PullRequestStatus, Turn } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TaskSummaryGutter } from "./task-summary-card"
import { TaskSummaryChip } from "./task-summary-chip"

/**
 * The summary card: one row per fact, each opening in place, and the chip it
 * folds into. What is pinned here is where each fact comes from (no read the
 * app does not already make), that the rows act on the real controls, and
 * the fold point, measured on the pane rather than the window.
 */

const CONNECTION = "test-connection"

const TASK: ApiTask = {
  id: "tk9zdy",
  title: "Paginate the library view",
  repo_path: "/Users/dev/work/sample-app",
  worktree_path: "/Users/dev/.wisp/worktrees/sample-app-tk9zdy",
  branch: "wisp/tk9zdy-paginate",
  base_commit: "8f2a1c9",
  harness: "claude",
  model: "claude-opus-5",
  effort: null,
  slot: 1,
  state: "done",
  state_detail: null,
  session_id: "s-1",
  seq: 4,
  turn_count: 2,
  archived: false,
  mode: "worktree",
  created_at: "2026-10-26T09:00:00Z",
  updated_at: "2026-10-26T09:30:00Z",
}

const WAITING: AutopilotStatus = {
  autoMerge: true, autoFix: true, autoReview: false, pr: 42, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr",
  by: "auto-merge", mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 1, done: false, updatedAt: null,
}

const FOUND: PullRequestStatus = { kind: "found", provider: "github", pullRequest: { ...PR_SPECIMEN, number: 42 } }

interface Call {
  path: string
  method: string
  body: unknown
}

function daemon(
  features: Record<string, boolean> = { taskAutopilot: true, autoReview: true, subtasks: true },
  refuse: string | null = null,
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (refuse && path.endsWith("/autopilot")) return new Response(JSON.stringify({ error: refuse }), { status: 409, headers: { "content-type": "application/json" } })
      const body = path.endsWith("/api/harnesses")
        ? { harnesses: [], features }
        : path.includes("/usage")
          ? { turns: [{ id: 1, n: 1, usage: { inputTokens: 1200, outputTokens: 300 } }], total: { inputTokens: 1200, outputTokens: 300 }, reporting_turns: 1, has_older_turns: false }
          : WAITING
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    }),
  )
  return calls
}

function mount(node: ReactNode, tasks: ApiTask[] = [TASK], tools?: Partial<ToolPanelControls>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(createConnectionQueryKeys(CONNECTION).tasksList(false), tasks)
  const wrapped = tools ? <ToolPanelContext.Provider value={tools as ToolPanelControls}>{node}</ToolPanelContext.Provider> : node
  return render(wrapped, { wrapper: runtimeWrapper(fakeDaemonTransport(CONNECTION, { request: api }), client) })
}

const card = (task: ApiTask, pullRequest?: PullRequestStatus, turns?: Turn[]) => (
  <TaskSummaryGutter task={task} pullRequest={pullRequest} turns={turns} />
)
const row = (name: RegExp) => screen.getByRole("button", { name })

beforeEach(() => {
  localStorage.clear()
  resetSummaryCardStore()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the lead row", () => {
  it("says a waiting question in the needs-input hue, and brings it on screen", () => {
    daemon()
    const intents = uiIntentsFor(CONNECTION)
    const before = intents.streamFocusRequests()
    mount(card({ ...TASK, state: "needs-input", pending_question_id: "q1" } as ApiTask))
    const lead = screen.getByRole("button", { name: /Waiting for you/ })
    expect(lead).toHaveTextContent("1 question")
    expect(within(lead).getByText("Waiting for you")).toHaveClass("text-state-needs-input")
    fireEvent.click(lead)
    expect(intents.streamFocusRequests()).toBe(before + 1)
  })

  it("times a running turn, and is no button while nothing waits", () => {
    daemon()
    const startedAt = new Date(Date.now() - 67_000).toISOString()
    mount(card({ ...TASK, state: "running" }, undefined, [{ id: 1, n: 1, status: "running", started_at: startedAt, ended_at: null } as Turn]))
    expect(screen.getByTestId("task-summary")).toHaveTextContent(/Running1m 0[67]s/)
    expect(screen.queryByRole("button", { name: /Running/ })).toBeNull()
  })

  it("says how long ago a settled task finished, and an exit code over the bare word", () => {
    daemon()
    const endedAt = new Date(Date.now() - 4 * 60_000).toISOString()
    mount(card({ ...TASK, state: "failed", latest_turn_has_result: true, latest_turn_exit_code: 3 } as ApiTask, undefined, [
      { id: 1, n: 1, status: "failed", started_at: endedAt, ended_at: endedAt } as Turn,
    ]))
    expect(screen.getByTestId("task-summary")).toHaveTextContent("Exited 34 min ago")
    expect(screen.getByText("Exited 3")).toHaveClass("text-state-failed")
  })
})

describe("the pull request row", () => {
  it("says the number and the lifecycle, and opens to CI, review, merge state and GitHub", async () => {
    daemon()
    mount(card(TASK, FOUND))
    const pr = row(/Pull request/)
    expect(pr).toHaveTextContent("#42 · Open")
    fireEvent.click(pr)
    expect(await screen.findByText("Open on GitHub ↗")).toHaveAttribute("href", PR_SPECIMEN.url)
    expect(screen.getByText(/^CI .* · .*/)).toBeInTheDocument()
  })

  it("says there is none yet, and has nothing to open", () => {
    daemon()
    mount(card(TASK, { kind: "none", provider: "github" }))
    expect(screen.getByText("None yet")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Pull request/ })).toBeNull()
  })

  it("is not drawn for an origin no forge answers for", () => {
    daemon()
    mount(card(TASK, { kind: "unsupported", provider: null }))
    expect(screen.queryByText("Pull request")).toBeNull()
  })
})

describe("the autopilot row", () => {
  it("says the live reason, and opens to the three switches, which are the real ones", async () => {
    const calls = daemon()
    mount(card({ ...TASK, autopilot: WAITING }, FOUND))
    const autopilot = await screen.findByRole("button", { name: /Autopilot/ })
    expect(autopilot).toHaveTextContent("Waiting for checks (2 running)")
    fireEvent.click(autopilot)
    const review = await screen.findByRole("switch", { name: "Auto-review" })
    expect(screen.getByRole("switch", { name: "Auto-merge" })).toHaveAttribute("aria-checked", "true")
    fireEvent.click(review)
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot`, method: "PUT", body: { autoReview: true } }))
  })

  it("keeps a refused write on the task that sent it, not the next task shown", async () => {
    // the shell keeps one card mounted and swaps its task, as a sidebar click does
    daemon(undefined, "Auto-merge needs GitHub")
    const other = { ...TASK, id: "tother", title: "Another task" }
    const view = mount(card(TASK))
    fireEvent.click(await screen.findByRole("button", { name: /Autopilot/ }))
    fireEvent.click(await screen.findByRole("switch", { name: "Auto-merge" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Auto-merge needs GitHub")
    view.rerender(card(other))
    expect(await screen.findByRole("switch", { name: "Auto-merge" })).not.toBeDisabled()
    expect(screen.queryByRole("alert")).toBeNull()
    view.rerender(card(TASK))
    expect(await screen.findByRole("alert")).toHaveTextContent("Auto-merge needs GitHub")
  })

  it("leaves history and rounds to the Autopilot panel, which it opens", async () => {
    daemon()
    const show = vi.fn()
    mount(card({ ...TASK, autopilot: WAITING }), [TASK], { show })
    fireEvent.click(await screen.findByRole("button", { name: /Autopilot/ }))
    fireEvent.click(await screen.findByRole("button", { name: /Open Autopilot/ }))
    expect(show).toHaveBeenCalledWith("autopilot")
  })

  it("says Off while no switch is on, and is absent on a daemon without autopilot", async () => {
    daemon()
    const view = mount(card(TASK))
    expect(await screen.findByRole("button", { name: /Autopilot/ })).toHaveTextContent("Off")
    view.unmount()
    const calls = daemon({})
    mount(card(TASK))
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/api/harnesses"))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText("Autopilot")).toBeNull()
  })
})

describe("the session box", () => {
  const child = (id: string, state: ApiTask["state"], title: string): ApiTask => ({ ...TASK, id, state, title, parent_task_id: TASK.id, subtask_kind: "explore" })
  const CHILDREN = [child("tc1", "running", "Check how old offset links behave"), child("tc2", "done", "Measure the list query on 50k rows")]

  it("rolls the children up from the live list, and opens one", async () => {
    const calls = daemon()
    mount(card(TASK), [TASK, ...CHILDREN])
    const subtasks = await screen.findByRole("button", { name: /Subtasks/ })
    expect(subtasks).toHaveTextContent("1 running · 2")
    fireEvent.click(subtasks)
    const intents = uiIntentsFor(CONNECTION)
    fireEvent.click(await screen.findByRole("button", { name: /Measure the list query/ }))
    expect(intents.taskFocusRequest()?.taskId).toBe("tc2")
    // the children are the live list's rows: nothing asked the subtasks route
    expect(calls.some((call) => call.path.includes("/subtasks"))).toBe(false)
  })

  it("shows what the model is carrying, and the /tokens report only once opened", async () => {
    const calls = daemon()
    mount(card({ ...TASK, context_tokens: 84_000 }))
    const context = row(/Context/)
    expect(context).toHaveTextContent("84.0k")
    expect(calls.some((call) => call.path.includes("/usage"))).toBe(false)
    fireEvent.click(context)
    expect(await screen.findByTestId("tokens-total")).toBeInTheDocument()
    expect(calls.filter((call) => call.path.includes("/usage"))).toHaveLength(1)
  })

  it("says nothing at all for a harness that cannot report a context, and drops the empty box", () => {
    // droid and cursor report usage only as a per-turn SUM; the daemon sends
    // no number rather than a wrong one, and the card must not invent a 0.
    daemon({})
    mount(card({ ...TASK, harness: "droid", context_tokens: null }))
    expect(screen.queryByText("Context")).toBeNull()
  })
})

describe("remembered choices", () => {
  it("keeps a row open for every task, across a remount", async () => {
    daemon()
    const view = mount(card(TASK, FOUND))
    fireEvent.click(row(/Pull request/))
    await screen.findByText("Open on GitHub ↗")
    view.unmount()
    mount(card({ ...TASK, id: "tother" }, FOUND))
    expect(await screen.findByText("Open on GitHub ↗")).toBeInTheDocument()
  })

  it("remembers a person's choice to fold the card", () => {
    daemon()
    function Probe() {
      const [folded] = useSummaryFolded()
      return <span data-testid="folded">{String(folded)}</span>
    }
    mount(<>{card(TASK)}<Probe /></>)
    fireEvent.click(screen.getByRole("button", { name: "Fold into the top bar" }))
    expect(screen.getByTestId("folded")).toHaveTextContent("true")
    expect(localStorage.getItem("wisp_summary_card_folded")).toBe("1")
  })
})

describe("the fold point", () => {
  let observed: ((entries: { contentRect: { width: number } }[]) => void)[] = []
  beforeEach(() => {
    observed = []
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
        observed.push(callback)
      }
      observe() {}
      disconnect() {}
    })
  })

  function Pane() {
    const [pane, setPane] = useState<HTMLElement | null>(null)
    return <main ref={setPane}>{usePaneFitsCard(pane) ? "card" : "chip"}</main>
  }

  it("is the pane's own width: 999px folds, 1001px keeps the card", () => {
    render(<Pane />)
    // jsdom lays nothing out: the first read before paint is 0
    expect(screen.getByRole("main")).toHaveTextContent("chip")
    act(() => observed.at(-1)!([{ contentRect: { width: 1001 } }]))
    expect(screen.getByRole("main")).toHaveTextContent("card")
    act(() => observed.at(-1)!([{ contentRect: { width: 999 } }]))
    expect(screen.getByRole("main")).toHaveTextContent("chip")
  })
})

describe("the chip", () => {
  it("names the state and the PR, and opens the same card as a popover", async () => {
    daemon()
    mount(<TaskSummaryChip task={{ ...TASK, state: "running", autopilot: WAITING }} pullRequest={FOUND} turns={undefined} roomy={false} />)
    const chip = screen.getByRole("button", { name: "Task summary: Running · PR #42" })
    expect(chip).toHaveTextContent("Running·#42")
    fireEvent.click(chip)
    const popup = await screen.findByRole("dialog", { name: "Task summary" })
    expect(within(popup).getByRole("button", { name: /Pull request/ })).toHaveTextContent("#42 · Open")
    // folded by the pane, not by a person: there is nothing to put back
    expect(within(popup).queryByRole("button", { name: "Show beside the conversation" })).toBeNull()
    // a long /tokens report or many children scroll inside it, within the height left below the bar
    expect(popup).toHaveClass("max-h-(--available-height)", "overflow-y-auto")
  })

  it("focuses the popover itself when a pointer opens it, and its first row when the keyboard does", async () => {
    daemon()
    mount(<TaskSummaryChip task={{ ...TASK, state: "running" }} pullRequest={FOUND} turns={undefined} roomy={false} />)
    const chip = screen.getByRole("button", { name: /Task summary/ })
    fireEvent.pointerDown(chip, { pointerType: "mouse" })
    fireEvent.click(chip, { detail: 1 })
    const popup = await screen.findByRole("dialog", { name: "Task summary" })
    await waitFor(() => expect(popup).toHaveFocus())

    fireEvent.keyDown(popup, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // a click with no pointer behind it (`detail` 0) is Enter or Space on the chip
    fireEvent.click(chip, { detail: 0 })
    const again = await screen.findByRole("dialog", { name: "Task summary" })
    await waitFor(() => expect(again).toContainElement(document.activeElement as HTMLElement))
    expect(again).not.toHaveFocus()
  })

  it("puts a folded card back beside the conversation where there is room", async () => {
    daemon()
    localStorage.setItem("wisp_summary_card_folded", "1")
    resetSummaryCardStore()
    mount(<TaskSummaryChip task={TASK} turns={undefined} roomy />)
    fireEvent.click(screen.getByRole("button", { name: /Task summary/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Show beside the conversation" }))
    expect(localStorage.getItem("wisp_summary_card_folded")).toBe("0")
  })
})
