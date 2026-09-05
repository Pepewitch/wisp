import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ActivityList } from "./activity-list"
import type { SubagentActivityItem } from "@/stream/reducer"

function subagent(overrides: Partial<SubagentActivityItem> = {}): SubagentActivityItem {
  return {
    kind: "subagent",
    id: "agent-1",
    agentId: "session-1",
    title: "Trace event flow",
    agentType: "explorer",
    model: null,
    effort: "medium",
    prompt: "Inspect the adapter boundary.",
    result: null,
    error: null,
    status: "running",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    background: false,
    items: [
      {
        kind: "tool",
        id: "read-1",
        name: "Read",
        input: { file_path: "src/adapters/activity.ts" },
        output: "source",
        error: null,
        status: "completed",
      },
    ],
    ...overrides,
  }
}

describe("ActivityList subagent UX", () => {
  it("starts collapsed with developer metadata and a visible status", () => {
    render(<ActivityList items={[subagent()]} onBeforeToggle={vi.fn()} />)
    const trigger = screen.getByRole("button", { name: /Trace event flow/i })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveClass("min-h-11")
    expect(screen.getByText("Explorer")).toBeInTheDocument()
    expect(screen.getByText("Medium")).toBeInTheDocument()
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.queryByText("Inspect the adapter boundary.")).toBeNull()
  })

  it("expands assignment and nested activity, then exposes full tool output", () => {
    render(<ActivityList items={[subagent()]} onBeforeToggle={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /Trace event flow/i }))

    expect(screen.getByText("Assignment")).toBeInTheDocument()
    expect(screen.getByText("Inspect the adapter boundary.")).toBeInTheDocument()
    const tool = screen.getByRole("button", { name: /Read.*src\/adapters\/activity\.ts/i })
    fireEvent.click(tool)
    expect(screen.getByText(/"file_path": "src\/adapters\/activity\.ts"/)).toBeInTheDocument()
    expect(screen.getByText(/source/)).toBeInTheDocument()
  })

  it("shows failure while collapsed and the exact issue on expansion", () => {
    render(
      <ActivityList
        items={[subagent({ status: "failed", error: "Child process exited 1", items: [] })]}
        onBeforeToggle={vi.fn()}
      />,
    )
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.queryByText("Child process exited 1")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Trace event flow/i }))
    expect(screen.getByText("Issue")).toBeInTheDocument()
    expect(screen.getByText("Child process exited 1")).toBeInTheDocument()
  })

  it("keeps parallel children independently expandable", () => {
    render(
      <ActivityList
        items={[
          subagent({ id: "a", title: "Review API", prompt: "Inspect API." }),
          subagent({ id: "b", title: "Review UI", prompt: "Inspect UI." }),
        ]}
        onBeforeToggle={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Review API/i }))
    expect(screen.getByText("Inspect API.")).toBeInTheDocument()
    expect(screen.queryByText("Inspect UI.")).toBeNull()
    expect(screen.getByRole("button", { name: /Review UI/i })).toHaveAttribute("aria-expanded", "false")
  })

  it("preserves open state across lifecycle updates with the same id", () => {
    const { rerender } = render(<ActivityList items={[subagent()]} onBeforeToggle={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: /Trace event flow/i }))
    expect(screen.getByText("Inspect the adapter boundary.")).toBeInTheDocument()

    rerender(
      <ActivityList
        items={[subagent({ status: "completed", result: "All paths verified" })]}
        onBeforeToggle={vi.fn()}
      />,
    )
    expect(screen.getByRole("button", { name: /Trace event flow/i })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Completed")).toBeInTheDocument()
    expect(screen.getByText("All paths verified")).toBeInTheDocument()
  })

  it("renders child subagents recursively inside their parent", () => {
    const child = subagent({ id: "child", title: "Inspect reducer", prompt: "Inspect nesting.", items: [] })
    const parent = subagent({ id: "parent", title: "Coordinate review", items: [child] })
    render(<ActivityList items={[parent]} onBeforeToggle={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: /Coordinate review/i }))
    expect(screen.getByRole("button", { name: /Inspect reducer/i })).toBeInTheDocument()
  })

  it("shows a real duration and omits a 0s label from a missing start time", () => {
    render(
      <ActivityList
        items={[subagent({ status: "completed", durationMs: 3980, startedAt: null, endedAt: "2026-09-03T09:50:08.348Z" })]}
        onBeforeToggle={vi.fn()}
      />,
    )
    expect(screen.getByText("4s")).toBeInTheDocument()

    render(
      <ActivityList
        items={[
          subagent({
            id: "zero",
            title: "Commit the RED tests",
            status: "completed",
            durationMs: 0,
            startedAt: "2026-09-03T09:50:08.348Z",
            endedAt: "2026-09-03T09:50:08.348Z",
          }),
        ]}
        onBeforeToggle={vi.fn()}
      />,
    )
    expect(screen.queryByText("0s")).toBeNull()
  })
})
