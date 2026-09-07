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
  it("offers rename and archive only", async () => {
    mount(<TaskActions task={TASK} />)
    fireEvent.click(screen.getByRole("button", { name: "More actions" }))

    const items = await screen.findAllByRole("menuitem")
    expect(items.map((el) => el.textContent)).toEqual(["Rename", "Archive"])
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
    expect(calls[1]!.body).toEqual({ force: true })
  })

  it("renders no dialog while nothing has been refused", () => {
    mount(<TaskActions task={TASK} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
