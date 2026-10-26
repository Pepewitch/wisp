import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { createConnectionQueryKeys } from "@/lib/query"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { PR_SPECIMEN } from "./gallery-fixtures"
import { TopBarTask } from "./top-bar-task"

/**
 * The top bar carries the task: its title is the trigger for every verb the
 * old header's `⋯` menu held, and the facts the header's meta line showed are
 * the menu's header. What is pinned here is that nothing became unreachable
 * (by mouse or keyboard), and that the bar stays a window drag region on
 * Desktop without its controls dragging the window.
 */

const TASK: ApiTask = {
  id: "tk9zdy",
  title: "Paginate the library view",
  repo_path: "/tmp/repo",
  worktree_path: "/tmp/wt",
  branch: "wisp/tk9zdy-paginate",
  base_commit: "8f2a1c9",
  harness: "claude",
  model: "claude-opus-5",
  effort: "high",
  slot: 1,
  state: "running",
  state_detail: null,
  session_id: "s-1",
  seq: 4,
  turn_count: 3,
  archived: false,
  mode: "worktree",
  created_at: "2026-08-30T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
}

const PARENT: ApiTask = { ...TASK, id: "tparnt", title: "Rework the library", branch: "wisp/tparnt-rework" }
const CHILD: ApiTask = {
  ...TASK,
  id: "tchild",
  title: "Measure the list query",
  parent_task_id: PARENT.id,
  subtask_kind: "explore",
  base_from: "project",
  base_sha: "1234567abcdef",
}

function mount(node: ReactNode, tasks: ApiTask[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(createConnectionQueryKeys("test-connection").tasksList(false), tasks)
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api }), client),
  })
}

function daemon() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).endsWith("/api/harnesses")
        ? { harnesses: [], features: { taskAutopilot: true, autoReview: true, subtasks: true } }
        : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const titleButton = (name: string | RegExp = /Paginate the library view/) => screen.getByRole("button", { name })

describe("the top bar's task", () => {
  it("is the page's one heading: the title, led by the state dot", () => {
    mount(<TopBarTask task={TASK} dragRegion={false} />)
    const h1 = screen.getByRole("heading", { level: 1 })
    expect(h1).toHaveTextContent("Paginate the library view")
    expect(h1.querySelector('[data-state="running"]')).toHaveAttribute("title", "Running")
    // the old header's meta line is on demand now, not in view
    expect(screen.queryByText(/tk9zdy/)).toBeNull()
    expect(screen.queryByText(/claude-opus-5/)).toBeNull()
  })

  it("renders an empty drag strip when no task is selected", () => {
    const { container } = mount(<TopBarTask task={null} dragRegion />)
    expect(container.firstElementChild).toHaveAttribute("data-tauri-drag-region", "")
    expect(screen.queryByRole("heading")).toBeNull()
  })

  it("marks Local and Archived only when true", () => {
    const view = mount(<TopBarTask task={TASK} dragRegion={false} />)
    expect(screen.queryByText("Local")).toBeNull()
    expect(screen.queryByText("Archived")).toBeNull()
    view.rerender(<TopBarTask task={{ ...TASK, mode: "local", archived: true }} dragRegion={false} />)
    expect(screen.getByText("Local")).toBeInTheDocument()
    expect(screen.getByText("Archived")).toBeInTheDocument()
  })

  it("leads a subtask with its parent, which opens the parent", () => {
    mount(<TopBarTask task={CHILD} dragRegion={false} />, [PARENT, CHILD])
    const parent = screen.getByRole("button", { name: "Rework the library" })
    expect(parent).toHaveAttribute("title", "Open Rework the library")
    expect(parent.closest("[data-subtask-crumb]")).toHaveTextContent("Rework the library›")
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Measure the list query")
  })

  it("says a subtask's parent was deleted rather than linking nowhere", () => {
    mount(<TopBarTask task={{ ...CHILD, parent_task_id: null }} dragRegion={false} />)
    expect(screen.getByText("a deleted task")).toBeInTheDocument()
  })

  it("keeps the PR link in the bar until the summary card takes it", () => {
    const found: PullRequestStatus = { kind: "found", provider: "github", pullRequest: PR_SPECIMEN }
    mount(<TopBarTask task={TASK} pullRequest={found} dragRegion={false} />)
    expect(screen.getByTestId("pull-request-status")).toHaveTextContent(`PR #${PR_SPECIMEN.number}`)
  })
})

describe("the title menu", () => {
  it("heads its verbs with the id, the branch and who is working on it", async () => {
    daemon()
    mount(<TopBarTask task={TASK} dragRegion={false} />)
    fireEvent.click(titleButton())
    const menu = await screen.findByRole("menu")
    expect(menu).toHaveTextContent("tk9zdy · wisp/tk9zdy-paginate")
    expect(menu).toHaveTextContent("Running · claude · claude-opus-5 · high effort")
  })

  it("names a subtask's kind and base in its header", async () => {
    daemon()
    mount(<TopBarTask task={CHILD} dragRegion={false} />, [PARENT, CHILD])
    fireEvent.click(titleButton(/Measure the list query/))
    expect(await screen.findByRole("menu")).toHaveTextContent("explore subtask · from the project's base at 1234567")
  })

  it("holds every verb the old `⋯` menu had, plus copying the id and the branch", async () => {
    daemon()
    mount(<TopBarTask task={TASK} dragRegion={false} />)
    fireEvent.click(titleButton())
    await screen.findByRole("menuitemcheckbox", { name: /Auto-merge/ })
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent)
    expect(items).toEqual(["Find in task⌘F", "Rename", "New subtask…", "Archive", "Copy task id", "Copy branch name"])
    expect(screen.getAllByRole("menuitemcheckbox").map((el) => el.textContent)).toEqual(["Auto-merge", "Auto-fix", "Auto-review"])
  })

  it("opens from the keyboard", async () => {
    daemon()
    mount(<TopBarTask task={TASK} dragRegion={false} />)
    const trigger = titleButton()
    expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    trigger.focus()
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    expect(await screen.findByRole("menuitem", { name: /Rename/ })).toBeInTheDocument()
  })

  it("copies the id and the branch", async () => {
    daemon()
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    mount(<TopBarTask task={TASK} dragRegion={false} />)
    fireEvent.click(titleButton())
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy task id" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("tk9zdy"))
    fireEvent.click(titleButton())
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy branch name" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("wisp/tk9zdy-paginate"))
  })

  it("offers no branch to copy when the task has none", async () => {
    daemon()
    mount(<TopBarTask task={{ ...TASK, branch: null }} dragRegion={false} />)
    fireEvent.click(titleButton())
    expect(await screen.findByRole("menuitem", { name: "Copy task id" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Copy branch name" })).toBeNull()
  })
})

describe("the window drag region on Desktop", () => {
  // Tauri starts a drag only when the element under the pointer carries the
  // attribute itself, and never on a button: the empty stretch must carry it,
  // and every control must not.
  it("marks the empty stretch and the quiet words, never a control", () => {
    const { container } = mount(<TopBarTask task={{ ...CHILD, mode: "local", context_tokens: 84_000 }} dragRegion />, [PARENT, CHILD])
    const regions = [...container.querySelectorAll("[data-tauri-drag-region]")]
    expect(regions.length).toBeGreaterThanOrEqual(4)
    expect(container.querySelectorAll("button[data-tauri-drag-region]")).toHaveLength(0)
    for (const button of container.querySelectorAll("button")) {
      expect(button.closest("[data-tauri-drag-region]")).not.toBe(button)
    }
    expect(screen.getByText("Local").closest("[data-tauri-drag-region]")).not.toBeNull()
    expect(screen.getByText("84.0k context")).toHaveAttribute("data-tauri-drag-region", "")
  })

  it("adds nothing in the browser", () => {
    const { container } = mount(<TopBarTask task={TASK} dragRegion={false} />)
    expect(container.querySelector("[data-tauri-drag-region]")).toBeNull()
  })
})
