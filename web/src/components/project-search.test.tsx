import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"
import { useProjectSearch } from "@/hooks/useProjectSearch"
import type { ApiTask, SearchResponse, SearchTaskHit } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

/**
 * Search across the projects, in the pane that lists them. The two things
 * worth protecting: a result says WHY it matched, and picking one is a single
 * gesture — the task opens with find-in-task already looking for the words.
 */
const CONNECTION = "project-search-test"

function task(id: string, title: string, repoPath: string): ApiTask {
  return {
    id,
    title,
    repo_path: repoPath,
    worktree_path: `/tmp/wt/${id}`,
    branch: `wisp/${id}`,
    base_commit: "8f2a1c9",
    harness: "claude",
    model: null,
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: null,
    seq: 1,
    turn_count: 1,
    archived: false,
    mode: "worktree",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  }
}

const WISP = task("taaaaa", "Vacuum the SSE bridge", "/repos/wisp")
const OTHER = task("tbbbbb", "Port the projects API", "/repos/other")

const GROUPS = [
  { path: "/repos/wisp", name: "wisp", exists: true, unlisted: false, tasks: [WISP] },
  { path: "/repos/other", name: "other", exists: true, unlisted: false, tasks: [OTHER] },
]

function hitFor(task: ApiTask, over: Partial<SearchTaskHit> = {}): SearchTaskHit {
  return {
    id: task.id,
    title: task.title,
    repo_path: task.repo_path,
    updated_at: task.updated_at,
    state: task.state,
    archived: task.archived,
    matches: 1,
    snippets: [{ kind: "result", turn: 1, text: "vacuumed 4 files", offset: 0, length: 6 }],
    ...over,
  }
}

const ARCHIVED = { ...task("tccccc", "Vacuum the old bridge", "/repos/wisp"), archived: true }

const ANSWER: SearchResponse = {
  query: "vacuum",
  truncated: false,
  tasks: [
    hitFor(WISP, {
      matches: 3,
      snippets: [{ kind: "prompt", turn: 2, text: "…please vacuum the reducer", offset: 8, length: 6 }],
    }),
    hitFor(OTHER),
  ],
}

/** The same answer plus one archived hit — what the switch governs. */
const WITH_ARCHIVED: SearchResponse = {
  ...ANSWER,
  tasks: [...ANSWER.tasks, hitFor(ARCHIVED, { matches: 2 })],
}

function mount(answer: SearchResponse | Error = ANSWER, onSelect = vi.fn(), showArchived = false) {
  const requests: string[] = []
  const transport = fakeDaemonTransport(CONNECTION, {
    request: async <T,>(path: string) => {
      requests.push(path)
      if (path.startsWith("/api/repos")) return [] as T
      if (path.startsWith("/api/harnesses")) {
        return { harnesses: [], features: { taskSearch: true } } as T
      }
      if (answer instanceof Error) throw answer
      return answer as T
    },
  })

  function Harness() {
    const search = useProjectSearch(showArchived, true)
    return (
      <Sidebar
        groups={GROUPS}
        archivedTasks={[]}
        status={{}}
        pullRequests={{}}
        selectedId={null}
        onSelect={onSelect}
        showArchived={showArchived}
        onShowArchivedChange={() => {}}
        onNewTask={() => {}}
        onConfigureProject={() => {}}
        search={search}
        error={null}
        loading={false}
      />
    )
  }

  render(<Harness />, { wrapper: runtimeWrapper(transport) })
  return { onSelect, requests }
}

const openBox = () => {
  fireEvent.click(screen.getByRole("button", { name: "Search tasks" }))
  return screen.getByRole("textbox", { name: "Search tasks" })
}

const type = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: text } })
}

describe("the sidebar's search", () => {
  it("offers no control at all against a daemon that cannot answer", () => {
    function Harness() {
      // the flag absent — an older remote in a Desktop connection tab
      const search = useProjectSearch(false, false)
      return (
        <Sidebar
          groups={GROUPS}
          archivedTasks={[]}
          status={{}}
          pullRequests={{}}
          selectedId={null}
          onSelect={() => {}}
          showArchived={false}
          onShowArchivedChange={() => {}}
          onNewTask={() => {}}
          onConfigureProject={() => {}}
          search={search}
          error={null}
          loading={false}
        />
      )
    }
    render(<Harness />, { wrapper: runtimeWrapper(fakeDaemonTransport(CONNECTION)) })

    expect(screen.queryByRole("button", { name: "Search tasks" })).toBeNull()
  })

  it("opens from the header icon, focused, with the tree still showing", () => {
    mount()

    expect(openBox()).toHaveFocus()
    // an empty box has asked nothing, so the projects are still the pane
    expect(screen.getByRole("button", { name: /Settings for wisp/ })).toBeInTheDocument()
  })

  it("replaces the tree with results that say where they matched", async () => {
    mount()
    openBox()
    type("vacuum")

    expect(await screen.findByText("4 matches in 2 tasks")).toBeInTheDocument()
    expect(screen.getByText("prompt 2")).toBeInTheDocument()
    expect(screen.getByText("result 1")).toBeInTheDocument()
    // the daemon located the match; the row lights exactly that slice
    expect(screen.getAllByText("vacuum").length).toBeGreaterThan(0)
    // the count only shows where it is news
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("asks the daemon with the query percent-encoded", async () => {
    const { requests } = mount()
    openBox()
    type("100% done")

    await waitFor(() => expect(requests).toContain("/api/search?q=100%25%20done"))
  })

  it("holds archived hits back while Show archived is off — and counts them", async () => {
    mount(WITH_ARCHIVED)
    openBox()
    type("vacuum")

    expect(await screen.findByText(/4 matches in 2 tasks · 1 archived task hidden/)).toBeInTheDocument()
    expect(screen.queryByText("Vacuum the old bridge")).toBeNull()
    expect(screen.queryByText("Archived")).toBeNull()
  })

  it("shows them in their own section under the live ones once it is on", async () => {
    mount(WITH_ARCHIVED, vi.fn(), true)
    openBox()
    type("vacuum")

    expect(await screen.findByText("6 matches in 3 tasks")).toBeInTheDocument()
    const headings = screen.getAllByText(/^(wisp|other|Archived)$/).map((node) => node.textContent)
    expect(headings[headings.length - 1]).toBe("Archived")
    expect(screen.getByText("Vacuum the old bridge")).toBeInTheDocument()
  })

  it("keeps the keyboard on the rows that are visible", async () => {
    const onSelect = vi.fn()
    mount(WITH_ARCHIVED, onSelect)
    const box = openBox()
    type("vacuum")
    await screen.findByText(/1 archived task hidden/)

    // three ↓ over two visible rows wraps back to the first, never onto the
    // archived row the switch is hiding
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith(WISP.id)
  })

  it("points at the switch when every match is archived", async () => {
    mount({ query: "vacuum", truncated: false, tasks: [hitFor(ARCHIVED, { matches: 2 })] })
    openBox()
    type("vacuum")

    expect(await screen.findByText("No match in your live tasks.")).toBeInTheDocument()
    expect(screen.getByText(/One archived task matches — turn on Show archived/)).toBeInTheDocument()
  })

  it("asks once for a burst of keystrokes, not once per character", async () => {
    const { requests } = mount()
    openBox()
    type("v")
    type("va")
    type("vacuum")

    await waitFor(() =>
      expect(requests.filter((path) => path.startsWith("/api/search"))).toEqual(["/api/search?q=vacuum"]),
    )
  })

  it("picks a result: the task is selected and the transcript is already looking", async () => {
    const { onSelect } = mount()
    const intents = uiIntentsFor(CONNECTION)
    const before = intents.findRequest()?.seq ?? 0
    openBox()
    type("vacuum")

    fireEvent.click(await screen.findByText("Vacuum the SSE bridge"))

    expect(onSelect).toHaveBeenCalledWith(WISP.id)
    expect(intents.findRequest()?.seq).toBe(before + 1)
    expect(intents.findRequest()?.query).toBe("vacuum")
  })

  it("commits the highlighted result from the keyboard", async () => {
    const { onSelect } = mount()
    const box = openBox()
    type("vacuum")
    await screen.findByText("4 matches in 2 tasks")

    // ↓ twice moves past the first project's one row into the second
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "ArrowDown" })
    fireEvent.keyDown(box, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith(OTHER.id)
  })

  it("commits the first result when nothing is highlighted yet", async () => {
    const { onSelect } = mount()
    const box = openBox()
    type("vacuum")
    await screen.findByText("4 matches in 2 tasks")

    fireEvent.keyDown(box, { key: "Enter" })

    expect(onSelect).toHaveBeenCalledWith(WISP.id)
  })

  it("labels a prose hit as what the agent said, not as its result", async () => {
    mount({
      query: "coalescer",
      truncated: false,
      tasks: [
        hitFor(WISP, {
          snippets: [
            { kind: "prose", turn: 3, text: "I rewired the coalescer first", offset: 12, length: 10 },
          ],
        }),
      ],
    })
    openBox()
    type("coalescer")

    expect(await screen.findByText("said 3")).toBeInTheDocument()
  })

  it("says the index is still catching up, beside the results and instead of a miss", async () => {
    mount({ ...ANSWER, indexing: { remainingTurns: 412 } })
    openBox()
    type("vacuum")

    expect(
      await screen.findByText(/still indexing what the agent said in 412 older turns/),
    ).toBeInTheDocument()
  })

  it("does not let a miss read as final while the index is catching up", async () => {
    mount({ query: "vacuum", truncated: false, tasks: [], indexing: { remainingTurns: 1 } })
    openBox()
    type("vacuum")

    expect(await screen.findByText("No match in your tasks.")).toBeInTheDocument()
    expect(
      screen.getByText(/Still indexing what the agent said in 1 older turn — try again shortly/),
    ).toBeInTheDocument()
  })

  it("states its scope when there is nothing to show", async () => {
    mount({ query: "zzz", truncated: false, tasks: [] })
    openBox()
    type("zzz")

    expect(await screen.findByText("No match in your tasks.")).toBeInTheDocument()
    expect(screen.getByText(/Tool calls and reasoning are not searched/)).toBeInTheDocument()
  })

  it("shows a failed search as a failure rather than as no results", async () => {
    mount(new Error("daemon unreachable"))
    openBox()
    type("vacuum")

    expect(await screen.findByText("search: daemon unreachable")).toBeInTheDocument()
  })

  it("closes on Escape and gives the tree back", async () => {
    mount()
    const box = openBox()
    type("vacuum")
    await screen.findByText("4 matches in 2 tasks")

    act(() => {
      fireEvent.keyDown(box, { key: "Escape" })
    })

    expect(screen.queryByRole("textbox", { name: "Search tasks" })).toBeNull()
    expect(screen.getByRole("button", { name: /Settings for wisp/ })).toBeInTheDocument()
  })
})
