import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type {
  ApiTask,
  PullRequestInfo,
  PullRequestOverviewEntry,
  StatusEntry,
} from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TaskRow, TaskRowTouch } from "./task-row"

/**
 * D2: the sidebar row reveals ARCHIVE on hover, in the git-marks slot.
 *
 * The three things this file is really guarding are structural, and each one was
 * a way to get this wrong: the control must not be nested in the row's button
 * (invalid HTML, broken clicks, and it would select the row), it must not race
 * the hover card over the same 280ms (Q9), and it must not appear at all where
 * there is nothing to archive.
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

const DIRTY: StatusEntry = {
  branch: "wisp/tk9zdy-steer",
  dirtyFiles: 2,
  ahead: 1,
  unpushed: true,
  worktreeReason: null,
}

const ARCHIVE_LABEL = `Archive ${TASK.title}`

const PR: PullRequestInfo = {
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  title: "Show pull request status",
  lifecycle: "open",
  checks: "passed",
  review: "approved",
  mergeState: "ready",
  updatedAt: "2026-09-05T08:00:00Z",
}

function found(
  overrides: Partial<PullRequestInfo> = {},
  stale = false,
): PullRequestOverviewEntry {
  return {
    status: {
      kind: "found",
      provider: "github",
      pullRequest: { ...PR, ...overrides },
    },
    checkedAt: "2026-09-05T08:00:00Z",
    stale,
  }
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
function stubApi(handler: () => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const { status, body } = handler()
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the row's archive affordance", () => {
  it("a live row carries it; an archived row does not", () => {
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
    expect(screen.getByLabelText(ARCHIVE_LABEL)).toBeInTheDocument()

    mount(<TaskRow task={{ ...TASK, archived: true }} selected={false} onSelect={() => {}} />)
    expect(screen.getAllByLabelText(ARCHIVE_LABEL)).toHaveLength(1) // still just the live row's
  })

  it("touch keeps archive in the task header — the row gets nothing (Q9)", () => {
    mount(<TaskRowTouch task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
    expect(screen.queryByLabelText(ARCHIVE_LABEL)).toBeNull()
  })

  it("is a sibling of the row button, not a child of it", () => {
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
    const button = screen.getByLabelText(ARCHIVE_LABEL)
    expect(button.closest("button[data-task-id]")).toBeNull()
  })

  it("clicking it archives unforced and does NOT select the row", async () => {
    const onSelect = vi.fn()
    const calls = stubApi(() => ({ status: 200, body: { ok: true } }))
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={onSelect} />)

    fireEvent.click(screen.getByLabelText(ARCHIVE_LABEL))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ path: "/api/tasks/tk9zdy/archive", method: "POST", body: { force: false } })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("a 409 opens the shared dialog with the daemon's sentence, and Archive anyway forces it", async () => {
    let refuse = true
    const reason = "task has unpushed commits — push first, merge the branch, or archive with force"
    const calls = stubApi(() => (refuse ? { status: 409, body: { error: reason } } : { status: 200, body: { ok: true } }))
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)

    fireEvent.click(screen.getByLabelText(ARCHIVE_LABEL))
    expect(await screen.findByText(reason)).toBeInTheDocument()

    refuse = false
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toEqual({ path: "/api/tasks/tk9zdy/archive", method: "POST", body: { force: true } })
  })

  it("renders no dialog while there is nothing to decide", () => {
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByRole("button", { name: "Archive anyway" })).toBeNull()
  })
})

describe("the git-marks slot yields", () => {
  it("fades on a live row", () => {
    mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
    const marks = screen.getByTitle("2 dirty file(s)").parentElement!
    expect(marks.className).toContain("group-hover/row:opacity-0")
    expect(marks.className).toContain("group-focus-within/row:opacity-0")
  })

  it("does not fade on an archived row — nothing is revealed there", () => {
    mount(<TaskRow task={{ ...TASK, archived: true }} status={DIRTY} selected={false} onSelect={() => {}} />)
    const marks = screen.getByTitle("2 dirty file(s)").parentElement!
    expect(marks.className).not.toContain("group-hover/row:opacity-0")
  })
})

describe("the sidebar pull-request status", () => {
  it.each([
    {
      label: "gray for an ordinary open PR",
      entry: found(),
      tone: "text-muted-foreground",
    },
    {
      label: "red for a blocked PR",
      entry: found({ review: "required", mergeState: "blocked" }),
      tone: "text-destructive",
    },
    {
      label: "purple for a merged PR",
      entry: found({ lifecycle: "merged", mergeState: "unknown" }),
      tone: "text-primary",
    },
  ])("$label", ({ entry, tone }) => {
    mount(
      <TaskRow
        task={TASK}
        status={DIRTY}
        pullRequest={entry}
        selected={false}
        onSelect={() => {}}
      />,
    )
    const icon = screen.getByTestId("sidebar-pull-request-icon")
    expect(icon.querySelector("svg")).toHaveClass(tone)
    expect(icon.closest("a")).toBeNull()
  })

  it("retains a stale status and names its age in the tooltip", () => {
    mount(
      <TaskRow
        task={TASK}
        pullRequest={found({ review: "required", mergeState: "blocked" }, true)}
        selected={false}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByRole("img", { name: /PR #42 · Blocked · Status stale/ }))
      .toHaveAttribute("title", expect.stringContaining("last checked"))
  })

  it.each([
    { kind: "none", provider: "github" } as const,
    { kind: "unsupported", provider: null } as const,
    { kind: "unavailable", provider: "github" } as const,
  ])("renders no icon for $kind", (status) => {
    mount(
      <TaskRow
        task={TASK}
        pullRequest={{
          status,
          checkedAt: "2026-09-05T08:00:00Z",
          stale: false,
        }}
        selected={false}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByTestId("sidebar-pull-request-icon")).toBeNull()
  })

  it("does not render a PR icon for an archived task", () => {
    mount(
      <TaskRow
        task={{ ...TASK, archived: true }}
        pullRequest={found({ lifecycle: "merged" })}
        selected={false}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByTestId("sidebar-pull-request-icon")).toBeNull()
  })

  it("keeps the title flexible and truncating while PR and git marks stay fixed", () => {
    mount(
      <TaskRow
        task={{ ...TASK, title: "A task title that is much wider than the sidebar" }}
        status={DIRTY}
        pullRequest={found()}
        selected={false}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText("A task title that is much wider than the sidebar"))
      .toHaveClass("min-w-0", "flex-1", "truncate")
    expect(screen.getByTestId("sidebar-pull-request-icon")).toHaveClass(
      "shrink-0",
      "group-hover/row:opacity-0",
    )
    expect(screen.getByTitle("2 dirty file(s)").parentElement).toHaveClass("shrink-0")
  })
})

describe("the hover card and the archive button do not race (Q9)", () => {
  /** Hover the row the way base-ui's own hover interaction sees it. */
  function hoverRow() {
    const row = document.querySelector(`[data-task-id="${TASK.id}"]`)!
    fireEvent.pointerEnter(row, { pointerType: "mouse" })
    fireEvent.mouseEnter(row)
    fireEvent.mouseMove(row)
  }

  it("hovering the row alone opens the card past its 280ms delay", async () => {
    vi.useFakeTimers()
    try {
      mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
      hoverRow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(screen.getByText(TASK.branch!)).toBeInTheDocument() // the card's own rows
    } finally {
      vi.useRealTimers()
    }
  })

  it("while the pointer is over archive, the card cannot open", async () => {
    vi.useFakeTimers()
    try {
      mount(<TaskRow task={TASK} status={DIRTY} selected={false} onSelect={() => {}} />)
      fireEvent.pointerEnter(screen.getByLabelText(ARCHIVE_LABEL), { pointerType: "mouse" })
      hoverRow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(screen.queryByText(TASK.branch!)).toBeNull()

      // and it comes back once the pointer moves off the button
      fireEvent.pointerLeave(screen.getByLabelText(ARCHIVE_LABEL), { pointerType: "mouse" })
      hoverRow()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      expect(screen.getByText(TASK.branch!)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
