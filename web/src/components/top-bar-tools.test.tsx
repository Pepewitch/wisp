import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { ToolPanelContext, type ToolPanelControls } from "@/hooks/useToolPanel"
import type { DaemonTransport } from "@/lib/transport"
import type { PullRequestStatus } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TopBarTools } from "./top-bar-tools"

const task = { ...TASKS[0]!, archived: false, worktree_path: "/tmp/wt" }

const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n")

function daemon(shells: { program: string | null }[]) {
  const request = vi.fn(async (path: string) => {
    if (path === "/api/harnesses") return { harnesses: [], features: { taskAutopilot: true, taskWorkflows: true, subtasks: true, taskTerminals: true } }
    if (path.endsWith("/diff")) return { diff: DIFF, untracked: ["notes.md"], base: null, worktreeReason: null }
    if (path.endsWith("/workflows")) return [{ id: "w1", state: "active" }, { id: "w2", state: "completed" }]
    if (path.endsWith("/terminals")) return shells.map((shell, id) => ({ id, number: id + 1, name: null, title: null, shell: "zsh", exitCode: null, createdAt: "", ...shell }))
    return []
  })
  return fakeDaemonTransport("conn", { request: request as unknown as DaemonTransport["request"] })
}

function controls(over: Partial<ToolPanelControls> = {}): ToolPanelControls {
  return {
    layout: { tool: null, terminal: false },
    open: false,
    available: ["terminal", "changes", "autopilot", "subtasks", "workflows"],
    toggle: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    togglePanel: vi.fn(),
    closePanel: vi.fn(),
    claimTerminalFocus: () => false,
    ...over,
  }
}

function mount(c: ToolPanelControls, shells: { program: string | null }[] = [], pullRequest?: PullRequestStatus) {
  return render(
    <ToolPanelContext.Provider value={c}>
      <TopBarTools task={task} pullRequest={pullRequest} dragRegion={false} />
    </ToolPanelContext.Provider>,
    { wrapper: runtimeWrapper(daemon(shells)) },
  )
}

describe("the top bar's tools", () => {
  it("lists every tool the daemon has, in the bar's order, each one a toggle", () => {
    const c = controls()
    mount(c)
    const names = screen.getAllByRole("button").map((button) => button.textContent)
    expect(names).toEqual(["Terminal", "Changes", "Autopilot", "Subtasks", "Workflows"])
    fireEvent.click(screen.getByRole("button", { name: /^Changes/ }))
    expect(c.toggle).toHaveBeenCalledWith("changes")
  })

  it("offers only Terminal and Changes until the daemon's features answer", () => {
    mount(controls({ available: null }))
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Terminal", "Changes"])
  })

  it("presses the open tool and the docked Terminal, and nothing else", () => {
    mount(controls({ layout: { tool: "changes", terminal: true }, open: true }))
    const pressed = screen.getAllByRole("button", { pressed: true }).map((button) => button.textContent)
    expect(pressed).toEqual(["Terminal", expect.stringMatching(/^Changes/)])
  })

  it("counts changed files and the workflows still watching, so the panel can stay closed", async () => {
    mount(controls())
    await waitFor(() => expect(screen.getByRole("button", { name: /^Changes/ })).toHaveTextContent("Changes2"))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Workflows/ })).toHaveTextContent("Workflows1"))
  })

  it("dots the Terminal while a shell has a program in the foreground", async () => {
    mount(controls(), [{ program: null }, { program: "bun" }])
    const terminal = screen.getByRole("button", { name: "Terminal" })
    await waitFor(() => expect(terminal).toHaveAttribute("title", "Terminal (⌃`) — running bun"))
    expect(terminal.querySelector(".bg-state-running")).not.toBeNull()
  })

  it("leaves the Terminal undotted at a prompt", async () => {
    mount(controls(), [{ program: null }])
    const terminal = screen.getByRole("button", { name: "Terminal" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(terminal.querySelector(".bg-state-running")).toBeNull()
  })

  it("tones the pull-request icon by its PR", () => {
    const pullRequest = {
      kind: "found",
      pullRequest: { number: 318, lifecycle: "merged", checks: "passed", review: "approved", mergeState: "ready", queuedToMerge: false },
      others: 0,
    } as unknown as PullRequestStatus
    mount(controls(), [], pullRequest)
    const autopilot = screen.getByRole("button", { name: "Autopilot" })
    expect(autopilot).toHaveAttribute("title", "Pull request #318 and autopilot")
    expect(autopilot.querySelector("svg")).toHaveClass("text-primary")
  })
})
