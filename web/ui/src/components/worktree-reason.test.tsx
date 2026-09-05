import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { ApiTask, StatusEntry } from "@/lib/types"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
}))

import { ChangesPane } from "./changes-pane"
import { TaskHeader } from "./task-header"
import { TaskRow } from "./task-row"

/**
 * D1's web half: a worktree git has forgotten reports itself in ONE muted line,
 * in the same register the archived-task placeholders use — and the sidebar row
 * stops being silent about it, which was the half of the bug nobody could see.
 */

const REASON =
  "Git no longer tracks this worktree (/Users/dev/.wisp/worktrees/sample-app-tk9zdy) — archive this task to clear the row; the files stay on disk."

const UNHEALTHY: StatusEntry = { branch: "wisp/tk9zdy-thing", worktreeReason: REASON }
const HEALTHY: StatusEntry = {
  branch: "wisp/tk9zdy-thing",
  dirtyFiles: 2,
  ahead: 1,
  unpushed: true,
  worktreeReason: null,
}

const TASK: ApiTask = {
  id: "tk9zdy",
  title: "The reported broken worktree",
  repo_path: "/Users/dev/work/sample-app",
  worktree_path: "/Users/dev/.wisp/worktrees/sample-app-tk9zdy",
  branch: "wisp/tk9zdy-thing",
  base_commit: "8f2a1c9",
  harness: "droid",
  model: "kimi-k3",
  effort: null,
  slot: 1,
  state: "done",
  state_detail: null,
  session_id: null,
  seq: 4,
  turn_count: 2,
  archived: false,
  mode: "worktree",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe("the sidebar row's git-marks slot", () => {
  // the row hangs the shared archive flow off itself (D2), which is a mutation
  it("shows muted words in place of the counts — never nothing at all", () => {
    withClient(<TaskRow task={TASK} status={UNHEALTHY} selected={false} onSelect={() => {}} />)
    const mark = screen.getByText("No worktree")
    expect(mark).toBeInTheDocument()
    // no chips, no hue: muted text is the whole vocabulary here (§2)
    expect(mark.className).toContain("text-muted-foreground")
    expect(mark.className).not.toContain("rounded-full")
    // the full sentence is one hover away rather than crammed into 26px
    expect(mark.getAttribute("title")).toBe(REASON)
  })

  it("still shows the counts when the worktree is readable", () => {
    withClient(<TaskRow task={TASK} status={HEALTHY} selected={false} onSelect={() => {}} />)
    expect(screen.queryByText("No worktree")).toBeNull()
    expect(screen.getByText("2")).toBeInTheDocument()
  })
})

describe("the task detail", () => {
  it("keeps the task's selected effort visible after its model in the header", () => {
    const { container } = withClient(<TaskHeader task={{ ...TASK, effort: "high" }} />)
    expect(container.textContent).toMatch(/droid.*kimi-k3.*high effort/)
  })

  it("does not render an interrupt control while the task is running", () => {
    withClient(<TaskHeader task={{ ...TASK, state: "running" }} />)
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull()
  })

  // the header hangs TaskActions off itself, and archive is a useMutation hook
  it("carries the reason as one muted line", () => {
    const { container } = withClient(<TaskHeader task={TASK} worktreeReason={REASON} />)
    const note = screen.getByText(REASON)
    expect(note.className).toContain("text-muted-foreground")
    expect(container.textContent).not.toContain("Push")
  })

  it("caps what it renders no matter what the daemon sent", () => {
    withClient(<TaskHeader task={TASK} worktreeReason={`first line\n${"y".repeat(400)}`} />)
    expect(screen.getByText("first line")).toBeInTheDocument()
    expect(screen.queryByText(/yyyy/)).toBeNull()
  })

  it("says nothing at all when the worktree is fine", () => {
    const { container } = withClient(<TaskHeader task={TASK} worktreeReason={null} />)
    expect(container.textContent).not.toContain("no longer tracks")
    expect(container.textContent).not.toContain("Push")
  })
})

describe("the Changes pane", () => {
  it("renders the daemon's 200-with-a-reason as a muted note, not an error", async () => {
    mocks.api.mockResolvedValue({
      diff: "",
      truncated: false,
      untracked: [],
      base: null,
      worktreeReason: REASON,
    })
    const { container } = withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText(REASON)).toBeInTheDocument())
    expect(screen.getByText(REASON).className).toContain("text-faint")
    expect(container.querySelector(".text-destructive")).toBeNull()
    expect(container.textContent).not.toContain("No changes in this worktree yet")
  })

  it("caps a wall of git output down to its first line", async () => {
    mocks.api.mockResolvedValue({
      diff: "",
      truncated: false,
      untracked: [],
      base: null,
      worktreeReason: [
        "warning: Not a git repository. Use --no-index to compare two paths outside a working tree",
        "usage: git diff [<options>] [<commit>] [--] [<path>...]",
        "    -p, --patch           generate patch",
      ].join("\n"),
    })
    const { container } = withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(container.textContent).toContain("Not a git repository"))
    expect(container.textContent).not.toContain("usage: git diff")
    expect(container.textContent).not.toContain("--patch")
  })
})
