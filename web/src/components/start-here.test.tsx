import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { StartHere } from "./start-here"
import type { FirstRunStep } from "@/lib/first-run"

const BLOCKED: FirstRunStep = {
  key: "daemon",
  title: "Wisp is running",
  state: "blocked",
  detail: "Local Wisp is not initialized.",
  action: { label: "Set up local Wisp", onClick: vi.fn() },
}
const OUTSTANDING: FirstRunStep = {
  key: "project",
  title: "A project",
  state: "todo",
  detail: "A Git repository Wisp will branch from.",
  action: { label: "Add project…", onClick: vi.fn() },
}
const DONE: FirstRunStep = {
  key: "harness",
  title: "An agent to run",
  state: "done",
  detail: "claude, codex",
}

function primaries(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter((node) => node.className.includes("bg-primary"))
}

describe("the panel spends the accent exactly once (§1)", () => {
  it("fills only the first outstanding step, whatever else is actionable", () => {
    render(
      <StartHere
        steps={[BLOCKED, DONE, OUTSTANDING]}
        baseLabel={null}
        onNewTask={vi.fn()}
      />
    )

    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent("Set up local Wisp")
  })

  it("hands it to the next step down once the one above is satisfied", () => {
    render(
      <StartHere
        steps={[{ ...BLOCKED, state: "done", action: undefined }, OUTSTANDING]}
        baseLabel={null}
        onNewTask={vi.fn()}
      />
    )

    expect(primaries()).toHaveLength(1)
    expect(primaries()[0]).toHaveTextContent("Add project…")
  })
})

describe("a step's own repair", () => {
  it("runs the action the step carries", () => {
    const onClick = vi.fn()
    render(
      <StartHere
        steps={[{ ...OUTSTANDING, action: { label: "Add project…", onClick } }]}
        baseLabel={null}
        onNewTask={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Add project…" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("reports a step that cannot be evaluated instead of guessing at it", () => {
    render(
      <StartHere
        steps={[
          BLOCKED,
          { key: "project", title: "A project", state: "todo", detail: "Checked once Wisp is running." },
        ]}
        baseLabel={null}
        onNewTask={vi.fn()}
      />
    )

    expect(screen.getByText("Checked once Wisp is running.")).toBeInTheDocument()
    // one door, and it is the daemon's
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })
})

describe("the ready panel is the whole tutorial", () => {
  it("collapses to one action and the worktree sentence", () => {
    const onNewTask = vi.fn()
    render(
      <StartHere
        steps={[DONE, { ...OUTSTANDING, state: "done", action: undefined, detail: "1 project" }]}
        baseLabel="main"
        onNewTask={onNewTask}
      />
    )

    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument()
    expect(primaries()).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "New task" }))
    expect(onNewTask).toHaveBeenCalledOnce()

    expect(
      screen.getByText(/its own branch and worktree/)
    ).toHaveTextContent("The agent works there, not in your checkout.")
    expect(screen.getByText("main")).toBeInTheDocument()
  })

  it("omits the base rather than inventing one the daemon has not resolved", () => {
    render(
      <StartHere
        steps={[DONE, { ...OUTSTANDING, state: "done", action: undefined }]}
        baseLabel={null}
        onNewTask={vi.fn()}
      />
    )

    expect(screen.getByText(/its own branch and worktree/)).not.toHaveTextContent(
      "from"
    )
  })

  it("refuses the action when there is no project for a task to live in", () => {
    render(
      <StartHere
        steps={[DONE, { ...OUTSTANDING, state: "done", action: undefined }]}
        baseLabel={null}
        onNewTask={undefined}
      />
    )

    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled()
  })
})
