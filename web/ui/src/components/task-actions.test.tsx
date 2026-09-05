import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApiTask } from "@/lib/types"

import { TaskActions } from "./task-actions"

/**
 * The regression this file guards: one `confirm` state used to do two jobs, so
 * a failed FRESH SESSION fell into the archive flow and opened the ARCHIVE
 * dialog — the daemon's "turn 2 is still running" under an "Archive anyway"
 * button that would have archived the task. Two states, two dialogs: a refused
 * fresh session renders its own close-only dialog with the server's sentence,
 * and only a refused archive ever shows "Archive anyway".
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
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

describe("the overflow menu's two dialogs", () => {
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

  it("a failed fresh session shows ITS error and never the archive dialog", async () => {
    const reason = "turn 2 is still running — interrupt it first"
    stubApi(() => ({ status: 409, body: { error: reason } }))
    mount(<TaskActions task={TASK} />)

    await pick("Fresh session")

    // the daemon's own sentence, verbatim, under the verb's own title
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toHaveTextContent("Fresh session")
    // the failure mode that shipped: this same refusal opening the archive confirm
    expect(screen.queryByRole("button", { name: "Archive anyway" })).toBeNull()
    expect(screen.queryByText(/Archive .*\?/)).toBeNull()

    // nothing to confirm — the dialog offers only to be closed
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
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
