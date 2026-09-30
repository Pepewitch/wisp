import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { buildTaskSurfaces } from "./task-surfaces"

/**
 * `buildTaskSurfaces` is where the terminal and diff/changes panes each get
 * their own `PaneErrorBoundary` (DEBT-01), keyed by task id. The daemon-shaped
 * child components are heavier than this test needs, so they are replaced
 * with stand-ins that throw for a chosen task id — this is about the wiring
 * in `task-surfaces.tsx` and `task-panel.tsx`, not about what can go wrong
 * inside a real shell or diff.
 */
vi.mock("@/components/terminal-pane", () => ({
  TerminalSection: ({ taskId }: { taskId: string | null }) => {
    if (taskId === "tk-term-bad") throw new Error("shell crashed")
    return <div>terminal for {taskId}</div>
  },
}))
vi.mock("@/components/changes-pane", () => ({
  ChangesPane: ({ taskId }: { taskId: string | null }) => {
    if (taskId === "tk-changes-bad") throw new Error("diff crashed")
    return <div>changes for {taskId}</div>
  },
}))
vi.mock("@/components/task-panel", () => ({
  TaskPanel: ({ taskId }: { taskId: string | null }) => <div>panel for {taskId}</div>,
}))

afterEach(() => vi.restoreAllMocks())

function surfaces(taskId: string | null, mobile = false) {
  return buildTaskSurfaces({
    mobile,
    features: undefined,
    connectionId: "conn",
    task: null,
    taskId,
    archived: false,
    onRefresh: () => {},
  })
}

function renderPanes(node: React.ReactNode) {
  return render(<div>{node}</div>, { wrapper: runtimeWrapper(fakeDaemonTransport()) })
}

describe("the terminal and changes panes buildTaskSurfaces returns", () => {
  it("degrades only the terminal when its shell throws, leaving the diff pane's own panel alone", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { terminal, changes } = surfaces("tk-term-bad")
    renderPanes(
      <>
        {terminal}
        {changes}
      </>,
    )
    expect(screen.getByText("Something went wrong showing the terminal.")).toBeInTheDocument()
    expect(screen.getByText("panel for tk-term-bad")).toBeInTheDocument()
  })

  it("resets on a task switch alone, with no Try again click", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const first = surfaces("tk-term-bad")
    const { rerender } = renderPanes(
      <>
        {first.terminal}
        {first.changes}
      </>,
    )
    expect(screen.getByText("Something went wrong showing the terminal.")).toBeInTheDocument()

    const second = surfaces("tk-term-good")
    rerender(
      <div>
        {second.terminal}
        {second.changes}
      </div>,
    )
    expect(screen.queryByText("Something went wrong showing the terminal.")).toBeNull()
    expect(screen.getByText("terminal for tk-term-good")).toBeInTheDocument()
  })

  it("degrades only the mobile diff pane when it throws, leaving the terminal alone", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { terminal, changes } = surfaces("tk-changes-bad", true)
    renderPanes(
      <>
        {terminal}
        {changes}
      </>,
    )
    expect(screen.getByText("Something went wrong showing the changes.")).toBeInTheDocument()
    expect(screen.getByText("terminal for tk-changes-bad")).toBeInTheDocument()
  })
})
