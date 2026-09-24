import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TaskActions } from "./task-actions"

/**
 * The overflow is rename and archive. Copy branch and Fresh session used to
 * live here; they must not reappear. Archive still uses the shared confirm so
 * a refusal shows "Archive anyway" and never a different verb's dialog.
 */

const TASK: ApiTask = {
  id: "tk9zdy",
  title: "Fix the steer box swallowing cmd-enter",
  repo_path: "/tmp/repo",
  worktree_path: "/tmp/wt",
  branch: "wisp/tk9zdy-steer",
  base_commit: "8f2a1c9",
  harness: "droid",
  model: "kimi-k3",
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
}

function mount(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api })),
  })
}

interface Call {
  path: string
  method: string
  body: unknown
}
function stubApi(handler: (path: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const { status, body } = handler(path)
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** base-ui's menu is a portal: click the trigger, then the item. */
async function pick(itemName: string) {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(itemName) }))
}

describe("the overflow menu", () => {
  it("offers find, rename and archive only", async () => {
    mount(<TaskActions task={TASK} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))

    const items = await screen.findAllByRole("menuitem")
    // Find carries its chord, because the menu is how you learn there is one.
    expect(items.map((el) => el.textContent)).toEqual(["Find in task⌘F", "Rename", "Archive"])
  })

  it("renames the task from the triple-dot menu", async () => {
    const calls = stubApi(() => ({ status: 200, body: { ...TASK, title: "Clear task name" } }))
    mount(<TaskActions task={TASK} />)

    await pick("Rename")

    const input = screen.getByLabelText("Task name")
    expect(input).toHaveValue(TASK.title)
    expect(input).toHaveAttribute("maxlength", "80")
    fireEvent.change(input, { target: { value: "  Clear task name  " } })
    fireEvent.click(screen.getByRole("button", { name: "Rename" }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: `/api/tasks/${TASK.id}`,
        method: "PATCH",
        body: { title: "Clear task name" },
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("a refused archive still gets the shared confirm, with Archive anyway forcing it", async () => {
    const reason = "task has unpushed commits — push first, or archive with force"
    let refuse = true
    const calls = stubApi(() => (refuse ? { status: 409, body: { error: reason } } : { status: 200, body: { ok: true } }))
    mount(<TaskActions task={TASK} />)

    await pick("Archive")

    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent(/Archive .*\?/)

    refuse = false
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }))
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/archive"))).toHaveLength(2))
    expect(calls.filter((c) => c.path.endsWith("/archive"))[1]!.body).toEqual({ force: true })
  })

  it("asks before archive stops auto-merge, and that confirm waives nothing else", async () => {
    const autopilot = {
      autoMerge: true, autoFix: false, pr: 7, state: "waiting" as const, reason: "Waiting for checks (2 running)",
      about: "pr" as const, by: "auto-merge" as const, mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
    }
    const reason = "task has unpushed commits — push first, or archive with force"
    let refuse = true
    const calls = stubApi((path) => (path.endsWith("/archive") && refuse ? { status: 409, body: { error: reason } } : { status: 200, body: { ok: true } }))
    mount(<TaskActions task={{ ...TASK, autopilot }} />)
    await pick("Archive")
    // asked on the spot, before anything reaches the daemon
    expect(await screen.findByText("Auto-merge is on for PR #7 — archiving switches it off.")).toBeInTheDocument()
    expect(calls.filter((c) => c.path.endsWith("/archive"))).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }))
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/archive"))).toHaveLength(1))
    expect(calls.filter((c) => c.path.endsWith("/archive"))[0]!.body).toEqual({ force: false, stopAutopilot: true })
    // the daemon still has its say about unsaved work, and forcing that is a second, separate choice
    expect(await screen.findByText(reason)).toBeInTheDocument()
    refuse = false
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }))
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/archive"))).toHaveLength(2))
    expect(calls.filter((c) => c.path.endsWith("/archive"))[1]!.body).toEqual({ force: true })
  })

  it("renders no dialog while nothing has been refused", () => {
    mount(<TaskActions task={TASK} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("auto-merge in the overflow menu", () => {
  const armed = (over: Partial<NonNullable<ApiTask["autopilot"]>> = {}): ApiTask => ({
    ...TASK,
    autopilot: { autoMerge: true, autoFix: false, pr: 7, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr", by: "auto-merge", mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null, ...over },
  })
  function daemon(extra: (path: string) => { status: number; body: unknown } | null = () => null) {
    return stubApi((path) => {
      if (path.endsWith("/api/harnesses")) return { status: 200, body: { harnesses: [], features: { taskAutopilot: true } } }
      return extra(path) ?? { status: 200, body: { autoMerge: true, autoFix: false, pr: null, state: "waiting", reason: "Waiting for a PR", about: "task", mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null } }
    })
  }
  async function open() {
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    return await screen.findByRole("menuitemcheckbox", { name: /Auto-merge/ })
  }

  it("is a switch that arms auto-merge without closing the menu", async () => {
    const calls = daemon()
    mount(<TaskActions task={TASK} />)
    const toggle = await open()
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot`, method: "PUT", body: { autoMerge: true } }))
    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-merge/ })).toBeInTheDocument()
  })

  it("names the bound PR and says what it is waiting for", async () => {
    daemon()
    mount(<TaskActions task={armed()} />)
    const toggle = await open()
    expect(toggle).toHaveTextContent("Auto-merge #7")
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Waiting for checks (2 running)")).toBeInTheDocument()
  })

  it("offers Resume for a pause and Continue now for a Stop hold, both through the resume route", async () => {
    const calls = daemon()
    const { unmount } = mount(<TaskActions task={armed({ state: "paused", reason: "Merge failed: Base branch was modified" })} />)
    await open()
    expect(screen.getByText("Paused — Merge failed: Base branch was modified")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/resume`, method: "POST", body: {} }))
    unmount()
    mount(<TaskActions task={armed({ state: "held", reason: "Held — you pressed Stop; continues after your next turn", about: "task" })} />)
    await open()
    fireEvent.click(screen.getByRole("menuitem", { name: "Continue now" }))
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/autopilot/resume"))).toHaveLength(2))
    // it stays open, so what happened can be read in place
    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-merge/ })).toBeInTheDocument()
  })

  it("keeps the switch where it was and says why when the daemon refuses", async () => {
    daemon((path) => path.endsWith("/autopilot") ? { status: 409, body: { error: "An archived task cannot auto-merge" } } : null)
    mount(<TaskActions task={TASK} />)
    const toggle = await open()
    fireEvent.click(toggle)
    expect(await screen.findByText("An archived task cannot auto-merge")).toBeInTheDocument()
    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-merge/ })).toHaveAttribute("aria-checked", "false")
  })

  it("says why when Wisp itself switched it off", async () => {
    daemon()
    mount(<TaskActions task={{ ...TASK, autopilot: { autoMerge: false, autoFix: false, pr: 7, state: "off", reason: "Auto-merge off — #7 was closed", about: "pr", by: "auto-merge", mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null } }} />)
    await open()
    expect(screen.getByText("Auto-merge off — #7 was closed")).toBeInTheDocument()
  })

  it("is not offered on an archived task", async () => {
    const calls = daemon()
    mount(<TaskActions task={{ ...TASK, archived: true }} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    await screen.findAllByRole("menuitem")
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/api/harnesses"))).toBe(true))
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull()
  })

  it("has its own auto-fix switch, and Send now / Skip for a round waiting out its delay", async () => {
    const calls = daemon()
    mount(<TaskActions task={armed({ autoMerge: false, autoFix: true, reason: "Auto-fix will send: test failing", pendingFix: { summary: "test failing", sendsAt: new Date(Date.now() + 60_000).toISOString() } })} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    const fix = await screen.findByRole("menuitemcheckbox", { name: /Auto-fix/ })
    expect(fix).toHaveAttribute("aria-checked", "true")
    expect(fix).toHaveTextContent("Auto-fix #7")
    expect(screen.getByRole("menuitemcheckbox", { name: /Auto-merge/ })).toHaveAttribute("aria-checked", "false")
    fireEvent.click(screen.getByRole("menuitem", { name: "Send now" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/send-now`, method: "POST", body: {} }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Skip" }))
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot/skip`, method: "POST", body: {} }))
    fireEvent.click(fix)
    await waitFor(() => expect(calls).toContainEqual({ path: `/api/tasks/${TASK.id}/autopilot`, method: "PUT", body: { autoFix: false } }))
  })

  it("offers Continue now, not Send now, while a Stop holds a pending round", async () => {
    daemon()
    mount(<TaskActions task={armed({ autoFix: true, state: "held", reason: "Held — you pressed Stop; continues after your next turn", pendingFix: { summary: "test failing", sendsAt: new Date().toISOString() } })} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    expect(await screen.findByRole("menuitem", { name: "Continue now" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Send now" })).toBeNull()
  })

  it("is disabled, and says why, for a task that runs in the project checkout", async () => {
    daemon()
    mount(<TaskActions task={{ ...TASK, mode: "local" }} />)
    const toggle = await open()
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(/Needs a worktree task/)).toBeInTheDocument()
  })

  it("is absent on a daemon that predates it", async () => {
    const calls = stubApi(() => ({ status: 200, body: { harnesses: [], features: {} } }))
    mount(<TaskActions task={TASK} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))
    await screen.findAllByRole("menuitem")
    // wait for the daemon's answer, or this would pass before it arrived
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/api/harnesses"))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull()
  })
})
