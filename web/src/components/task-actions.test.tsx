import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { createConnectionQueryKeys } from "@/lib/query"
import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TaskActions } from "./task-actions"

/** The title menu, as the top bar mounts it, with a plain trigger. */
function TitleMenu({ task }: { task: ApiTask }) {
  return <TaskActions task={task} title={{ trigger: "Task menu", className: "", header: null, after: null }} />
}

/**
 * The menu's verbs are find, rename and archive. Copy branch and Fresh session used to
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

function mount(node: ReactNode, tasks?: ApiTask[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (tasks) client.setQueryData(createConnectionQueryKeys("test-connection").tasksList(false), tasks)
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api }), client),
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
  fireEvent.click(screen.getByRole("button", { name: "Task menu" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: new RegExp(itemName) }))
}

describe("the title menu", () => {
  it("offers find, rename and archive only", async () => {
    mount(<TitleMenu task={TASK} />)
    fireEvent.click(screen.getByRole("button", { name: "Task menu" }))

    const items = await screen.findAllByRole("menuitem")
    // Find carries its chord, because the menu is how you learn there is one.
    expect(items.map((el) => el.textContent)).toEqual(["Find in task⌘F", "Rename", "Archive"])
  })

  it("renames the task from the title menu", async () => {
    const calls = stubApi(() => ({ status: 200, body: { ...TASK, title: "Clear task name" } }))
    mount(<TitleMenu task={TASK} />)

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
    mount(<TitleMenu task={TASK} />)

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
    mount(<TitleMenu task={{ ...TASK, autopilot }} />)
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
    // the autopilot yes already given rides along; forcing is the only new consent
    expect(calls.filter((c) => c.path.endsWith("/archive"))[1]!.body).toEqual({ force: true, stopAutopilot: true })
  })

  it("names a parent's every subtask, and takes, forces and stops their autopilot as three separate yeses", async () => {
    const child = (id: string, extra: Partial<ApiTask> = {}): ApiTask => ({ ...TASK, id, title: `Child ${id}`, parent_task_id: TASK.id, subtask_kind: "explore", ...extra })
    const tasks = [TASK, child("ca"), child("cb"), { ...child("rv"), parent_task_id: "ca", subtask_kind: "review", verify_role: "reviewer" } as ApiTask]
    const replies = [
      { status: 409, body: { error: "task tk9zdy has 2 live subtasks", refusedSubtasks: [
        { id: "ca", title: "Child ca", error: "a live subtask", needs: "subtasks" },
        { id: "cb", title: "Child cb", error: "a live subtask", needs: "subtasks" },
      ] } },
      { status: 409, body: { error: "1 of task tk9zdy's subtasks cannot be archived", refusedSubtasks: [
        { id: "cb", title: "Child cb", error: "worktree has 2 uncommitted changes" },
      ] } },
      { status: 409, body: { error: "1 of task tk9zdy's subtasks cannot be archived", refusedSubtasks: [
        { id: "cb", title: "Child cb", error: "Auto-merge is on for PR #9 — archiving switches it off.", needs: "stopAutopilot" },
      ] } },
      { status: 200, body: { ok: true, branch: null, note: null, subtasks: ["ca", "rv", "cb"] } },
    ]
    const calls = stubApi((path) => (path.endsWith("/archive") ? replies.shift()! : { status: 200, body: {} }))
    const bodies = () => calls.filter((c) => c.path.endsWith("/archive")).map((c) => c.body)
    mount(<TitleMenu task={TASK} />, tasks)
    await pick("Archive")
    // unforced and without the opt-in first: the daemon names the family
    const list = await screen.findByRole("list")
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Child caarchived with it",
      "Child rva reviewer: its review ends, and it is archived",
      "Child cbarchived with it",
    ])
    fireEvent.click(screen.getByRole("button", { name: "Archive with 3 subtasks" }))
    expect(await screen.findByText("worktree has 2 uncommitted changes")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Force all subtasks" }))
    expect(await screen.findByText("Auto-merge is on for PR #9 — archiving switches it off.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop their autopilot" }))
    await waitFor(() => expect(bodies()).toHaveLength(4))
    expect(bodies()).toEqual([
      { force: false },
      { force: false, subtasks: "archive" },
      { force: false, subtasks: "force" },
      { force: false, subtasks: "force", stopAutopilot: true },
    ])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("renders no dialog while nothing has been refused", () => {
    mount(<TitleMenu task={TASK} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
