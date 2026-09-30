import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AutopilotHistoryEntry, AutopilotStatus } from "../../../shared/autopilot"
import { api } from "@/lib/api"
import { AUTOPILOT_OFF_WORDS } from "@/lib/autopilot-words"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { AutopilotPane } from "./autopilot-pane"
import { TaskPanel } from "./task-panel"

const CONNECTION = "autopilot-connection"
const REPO = "https://github.com/example/editor"

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, pr: null, state: "off", reason: "", about: "task", by: "auto-merge",
  mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
}
const WAITING: AutopilotStatus = {
  ...OFF, autoMerge: true, autoFix: true, pr: 318, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr",
  fixRounds: 1, updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
}
const PAUSED: AutopilotStatus = { ...WAITING, state: "paused", reason: "Merge failed twice: a required check never reported" }

const TASK: ApiTask = {
  id: "tap1lt",
  title: "Stop duplicate saves in the editor",
  repo_path: "/tmp/repo",
  worktree_path: "/tmp/wt",
  branch: "wisp/tap1lt-saves",
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
  briefEnabled: false,
  autopilot: OFF,
}
const withStatus = (autopilot: AutopilotStatus): ApiTask => ({ ...TASK, autopilot })

let minute = 0
const entry = (kind: string, detail: string, pr: number | null, extra: Partial<AutopilotHistoryEntry> = {}): AutopilotHistoryEntry =>
  ({ at: new Date(Date.now() - ++minute * 60_000).toISOString(), kind, detail, pr, sha: null, messageId: null, ...extra })

function history(): AutopilotHistoryEntry[] {
  minute = 0
  return [
    entry("merged", "Merged #318 into main", 318, { sha: "9c41e07aa11" }),
    entry("merging", "Merging #318 at 9c41e07 into main (squash) · checks green", 318, { sha: "9c41e07aa11" }),
    entry("wait", "Waiting for checks (2 running)", 318),
    entry("wait", "Waiting for checks to start", 318),
    entry("wait", "Waiting for checks (1 running)", 318),
    entry("wake", "Review asks for a null check in saveDocument()", 318, { messageId: "m203" }),
    entry("bound", "Watching PR #318", 318),
    entry("armed", "Auto-merge on, Auto-fix on", null),
  ]
}

interface Call { path: string; method: string; body: unknown }

function stub(features: Record<string, boolean>, entries: AutopilotHistoryEntry[] = []): Call[] {
  const calls: Call[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = path.endsWith("/api/harnesses") ? { harnesses: [{ name: "codex", hasBriefs: true }], features }
      : path.endsWith("/autopilot/history") ? { history: entries }
      : path.endsWith("/pull-request") ? {
        kind: "found", provider: "github",
        pullRequest: { number: 318, url: `${REPO}/pull/318`, title: "Stop duplicate saves", lifecycle: "open", queuedToMerge: false, checks: "pending", review: "none", mergeState: "unknown", updatedAt: "2026-09-30T09:00:00Z" },
      }
      : path.includes("/autopilot") ? WAITING
      : path.endsWith("/diff") ? { diff: "", untracked: [], base: null, worktreeReason: null }
      : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }))
  return calls
}

const ALL = { taskBriefs: true, taskAutopilot: true, autopilotHistory: true }
const asked = (calls: Call[], suffix: string) => calls.some((c) => c.path.endsWith(suffix))

function mount(node: ReactNode) {
  const wrapper = runtimeWrapper(fakeDaemonTransport(CONNECTION, { request: api }))
  return render(node, { wrapper: wrapper as (props: { children: ReactNode }) => ReactNode })
}

afterEach(() => vi.unstubAllGlobals())

describe("the Autopilot tab", () => {
  it("opens the panel, first and labelled Autopilot, and never marks the tab itself", async () => {
    stub(ALL)
    mount(<TaskPanel task={withStatus(PAUSED)} taskId={TASK.id} archived={false} />)
    const tabs = await screen.findByRole("tablist", { name: "Task panel" })
    const first = within(tabs).getAllByRole("tab")[0]!
    expect(first).toHaveTextContent(/^Autopilot$/)
    expect(first).toHaveAttribute("aria-selected", "true")
    // the rail and the PR icon turn red; the tab stays plain
    expect(first.querySelector("[class*='bg-destructive']")).toBeNull()
  })

  it("off: the brief comes first, then the line, then switches that teach what they do", async () => {
    const calls = stub(ALL)
    mount(<AutopilotPane task={TASK} />)
    const automation = await screen.findByRole("region", { name: "Automation" })
    const brief = screen.getByRole("region", { name: "Task brief" })
    expect(brief.compareDocumentPosition(automation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the one full-width line, in the strongest border token
    expect(screen.getByRole("heading", { name: "Automation" }).parentElement!.className).toContain("border-border-strong")
    expect(within(automation).getByText(AUTOPILOT_OFF_WORDS["auto-merge"])).toBeInTheDocument()
    expect(within(automation).getByText(AUTOPILOT_OFF_WORDS["auto-fix"])).toBeInTheDocument()
    expect(await within(automation).findByText(/^Nothing yet\./)).toBeInTheDocument()
    fireEvent.click(within(automation).getByRole("switch", { name: "Auto-merge" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot`, method: "PUT", body: { autoMerge: true } }))
  })

  it("armed: the live line sits under the switch it speaks for, in the rail's blue, with the PR linked", async () => {
    stub(ALL)
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    const merge = (await screen.findByRole("switch", { name: "Auto-merge" })).parentElement!
    const line = merge.querySelector("[data-tint]")!
    expect(line).toHaveAttribute("data-tint", "on")
    expect(line.className).not.toContain("text-destructive")
    expect(line).toHaveTextContent("#318·Waiting for checks (2 running)·3 min ago")
    await waitFor(() => expect(within(merge).getByRole("link", { name: "#318" })).toHaveAttribute("href", `${REPO}/pull/318`))
    expect(screen.getByRole("switch", { name: "Auto-fix" }).parentElement).toHaveTextContent("On · 1 fix round sent")
  })

  it("needs you: the line is red, and Resume is the one action, through the resume route", async () => {
    const calls = stub(ALL)
    mount(<AutopilotPane task={withStatus(PAUSED)} />)
    const merge = (await screen.findByRole("switch", { name: "Auto-merge" })).parentElement!
    const line = merge.querySelector("[data-tint]")!
    expect(line).toHaveAttribute("data-tint", "needs-you")
    expect(line.className).toContain("text-destructive")
    expect(line).toHaveTextContent("Paused — Merge failed twice")
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull()
    fireEvent.click(within(merge).getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/resume`, method: "POST", body: {} }))
  })

  it("a round waiting out its delay offers Send now and Skip under Auto-fix, and a Stop hold offers Continue now", async () => {
    const calls = stub(ALL)
    const pending = { ...WAITING, by: "auto-fix" as const, reason: "Auto-fix will send: lint failed", pendingFix: { summary: "lint failed", sendsAt: new Date(Date.now() + 45_000).toISOString() } }
    const { unmount } = mount(<AutopilotPane task={withStatus(pending)} />)
    const fix = (await screen.findByRole("switch", { name: "Auto-fix" })).parentElement!
    expect(fix.querySelector("[data-tint]")).toHaveAttribute("data-tint", "on")
    expect(within(fix).getByText(/^sends in \d+s$/)).toBeInTheDocument()
    fireEvent.click(within(fix).getByRole("button", { name: "Send now" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/send-now`, method: "POST", body: {} }))
    fireEvent.click(within(fix).getByRole("button", { name: "Skip" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/skip`, method: "POST", body: {} }))
    unmount()
    mount(<AutopilotPane task={withStatus({ ...pending, state: "held", by: "auto-merge", reason: "Held — you pressed Stop", about: "task" })} />)
    expect(await screen.findByRole("button", { name: "Continue now" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull()
  })

  it("merged: violet, the three latest meaningful events, a SHA that opens its commit, and View message", async () => {
    stub(ALL, history())
    const done = { ...WAITING, pr: null, about: "task" as const, done: true, reason: "#318 merged by Wisp · Waiting for the task's next PR", lastMerged: { pr: 318, byWisp: true } }
    mount(<AutopilotPane task={withStatus(done)} />)
    const merge = (await screen.findByRole("switch", { name: "Auto-merge" })).parentElement!
    expect(merge.querySelector("[data-tint]")).toHaveAttribute("data-tint", "done")
    const list = await screen.findByRole("list")
    expect(within(list).getAllByRole("listitem").map((row) => row.firstElementChild?.nextElementSibling?.firstElementChild?.textContent))
      .toEqual(["Merged by Wisp", "Merging", "Fix round 1 sent"])
    await waitFor(() => expect(within(list).getAllByRole("link", { name: "9c41e07" })[0]).toHaveAttribute("href", `${REPO}/commit/9c41e07aa11`))
    fireEvent.click(within(list).getByRole("button", { name: "View message" }))
    expect(uiIntentsFor(CONNECTION).messageRevealRequest()).toMatchObject({ messageId: "m203" })
    expect(screen.getByRole("button", { name: /All history\s*8/ })).toBeInTheDocument()
  })

  it("All history opens the per-PR log with routine runs folded, and the back row returns", async () => {
    stub(ALL, history())
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    fireEvent.click(await screen.findByRole("button", { name: /All history/ }))
    const pr = screen.getByRole("region", { name: "PR #318" })
    expect(pr).toHaveTextContent("#318·Merged by Wisp")
    expect(pr).toHaveTextContent("1 fix round · 8 events")
    const folded = within(pr).getByRole("button", { expanded: false })
    expect(folded).toHaveTextContent("Waiting")
    expect(folded).toHaveTextContent("for checks ×3")
    // one run opens on a click; Routine checks opens them all
    fireEvent.click(folded)
    expect(within(pr).queryByRole("button", { expanded: false })).toBeNull()
    expect(within(pr).getAllByText(/^for checks/)).toHaveLength(3)
    const routine = screen.getByRole("switch", { name: "Routine checks" })
    fireEvent.click(routine)
    expect(routine).toHaveAttribute("aria-checked", "true")
    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    expect(screen.queryByRole("region", { name: "PR #318" })).toBeNull()
    expect(screen.getByRole("region", { name: "Automation" })).toBeInTheDocument()
  })

  it("keeps the overview mounted under the log, so back returns to the same place", async () => {
    stub(ALL, history())
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    const open = await screen.findByRole("button", { name: /All history/ })
    const scroller = open.closest(".overflow-y-auto") as HTMLElement
    scroller.scrollTop = 240
    fireEvent.click(open)
    expect(scroller.isConnected).toBe(true)
    expect(scroller.className).toContain("hidden")
    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    expect(screen.getByRole("button", { name: /All history/ }).closest(".overflow-y-auto")).toBe(scroller)
    expect(scroller.className).not.toContain("hidden")
    expect(scroller.scrollTop).toBe(240)
  })

  it("routine checks unfold every run at once", async () => {
    stub(ALL, history())
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    fireEvent.click(await screen.findByRole("button", { name: /All history/ }))
    fireEvent.click(screen.getByRole("switch", { name: "Routine checks" }))
    const pr = screen.getByRole("region", { name: "PR #318" })
    expect(within(pr).queryByRole("button", { expanded: false })).toBeNull()
    expect(within(pr).getAllByText("Waiting")).toHaveLength(3)
  })

  it("an older daemon without autopilotHistory draws no History and never asks for it", async () => {
    const calls = stub({ taskBriefs: true, taskAutopilot: true })
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    await screen.findByRole("region", { name: "Automation" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByRole("heading", { name: "History" })).toBeNull()
    expect(screen.queryByRole("button", { name: /All history/ })).toBeNull()
    expect(asked(calls, "/autopilot/history")).toBe(false)
  })

  it("a local task keeps the switches, disabled, and says why", async () => {
    stub(ALL)
    mount(<AutopilotPane task={{ ...TASK, mode: "local" }} />)
    expect(await screen.findByRole("switch", { name: "Auto-merge" })).toBeDisabled()
    expect(screen.getByText(/Needs a worktree task/)).toBeInTheDocument()
  })
})

describe("the docked Automation header", () => {
  type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void
  function observe() {
    const observers: Callback[] = []
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: Callback) { observers.push(callback) }
      observe() {}
      disconnect() {}
    })
    return (below: boolean | "hidden") => act(() => {
      for (const callback of observers) {
        callback([{
          isIntersecting: below === false,
          boundingClientRect: { top: below === true ? 900 : below === "hidden" ? 0 : 300 } as DOMRectReadOnly,
          // a pane under display:none has no box, so its root reads zero-height
          rootBounds: (below === "hidden" ? { bottom: 0, height: 0 } : { bottom: 680, height: 640 }) as DOMRectReadOnly,
        }])
      }
    })
  }

  it("docks with the live line, in red, while the section is below the fold, and scrolls there on a click", async () => {
    const fold = observe()
    stub(ALL)
    mount(<AutopilotPane task={withStatus(PAUSED)} />)
    const heading = await screen.findByRole("heading", { name: "Automation" })
    expect(screen.queryByRole("button", { name: /^Show Automation/ })).toBeNull()

    fold(true)
    const docked = screen.getByRole("button", { name: "Show Automation: #318 · Paused — Merge failed twice: a required check never reported" })
    expect(docked.className).toContain("text-destructive")
    expect(heading.parentElement).toHaveAttribute("data-docked", "true")
    expect(heading.parentElement!.className).toContain("sticky")
    const scroller = heading.closest(".overflow-y-auto") as HTMLElement
    // a sticky row docks only within its parent: it must be the scroller's own child
    expect(heading.parentElement!.parentElement).toBe(scroller)
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo
    fireEvent.click(docked)
    expect(scrollTo).toHaveBeenCalledOnce()

    // scrolled into place, it is a plain header again
    fold(false)
    expect(screen.queryByRole("button", { name: /^Show Automation/ })).toBeNull()
    expect(heading.parentElement).not.toHaveAttribute("data-docked")
  })

  it("stays a plain header while the pane is hidden, so coming back to the tab never flashes it", async () => {
    const fold = observe()
    stub(ALL)
    mount(<AutopilotPane task={withStatus(PAUSED)} />)
    const heading = await screen.findByRole("heading", { name: "Automation" })
    fold("hidden")
    expect(screen.queryByRole("button", { name: /^Show Automation/ })).toBeNull()
    expect(heading.parentElement).not.toHaveAttribute("data-docked")
  })

  it("docks in gray when nothing needs you", async () => {
    const fold = observe()
    stub(ALL)
    mount(<AutopilotPane task={withStatus(WAITING)} />)
    await screen.findByRole("heading", { name: "Automation" })
    fold(true)
    const docked = screen.getByRole("button", { name: /^Show Automation: #318 · Waiting for checks/ })
    expect(docked.className).toContain("text-muted-foreground")
    expect(docked.className).not.toContain("text-destructive")
  })
})
