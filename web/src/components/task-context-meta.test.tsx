import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TopBarTask } from "./top-bar-task"

/**
 * The top bar's context reading (it rides beside the title until the summary card takes it). It exists so nobody has to run `/context` to
 * learn it — which on the harnesses that answer costs real context, because
 * the report is written into the session it measures. What is pinned here is
 * the honesty rule: the number shows when the daemon observed one, and the
 * header says NOTHING when it did not, rather than rendering a zero.
 */

const TASK: ApiTask = {
  id: "tk9zdy",
  title: "A task carrying a conversation",
  repo_path: "/Users/dev/work/sample-app",
  worktree_path: "/Users/dev/.wisp/worktrees/sample-app-tk9zdy",
  branch: "wisp/tk9zdy-thing",
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
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

function withClient(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection")),
  })
}

describe("the top bar's context reading", () => {
  it("shows what the model is carrying, beside the title", () => {
    withClient(<TopBarTask task={{ ...TASK, context_tokens: 467_964 }} dragRegion={false} />)
    expect(screen.getByText("468.0k context")).toBeInTheDocument()
  })

  it("follows a compaction down, because the boundary is a reading too", () => {
    const view = withClient(<TopBarTask task={{ ...TASK, context_tokens: 467_964 }} dragRegion={false} />)
    view.rerender(<TopBarTask task={{ ...TASK, context_tokens: 9472 }} dragRegion={false} />)
    expect(screen.getByText("9.5k context")).toBeInTheDocument()
    expect(screen.queryByText("468.0k context")).not.toBeInTheDocument()
  })

  it("says nothing at all for a harness that cannot report one", () => {
    // droid and cursor report usage only as a per-turn SUM; the daemon sends
    // no number rather than a wrong one, and the header must not invent a 0.
    withClient(<TopBarTask task={{ ...TASK, harness: "droid", context_tokens: null }} dragRegion={false} />)
    expect(screen.queryByText(/context$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^0 context/)).not.toBeInTheDocument()
  })

  it("says nothing before the first turn settles", () => {
    withClient(<TopBarTask task={TASK} dragRegion={false} />)
    expect(screen.queryByText(/context$/)).not.toBeInTheDocument()
  })

  it("reads the same on a Desktop connection — the number is task state, not connection state", () => {
    // Desktop drives the same bundle through its native proxy transport. The
    // reading arrives on the task payload both clients already fetch, and this
    // pins that nothing connection-scoped creeps into rendering it.
    render(<TopBarTask task={{ ...TASK, context_tokens: 467_964 }} dragRegion={false} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport("desktop-remote-connection")),
    })
    expect(screen.getByText("468.0k context")).toBeInTheDocument()
  })
})
