import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ApiSubtask, ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SubtasksPane } from "./subtasks-pane"

const PARENT = { id: "tparent", title: "Orchestrate", archived: false, subtask_kind: null, parent_task_id: null } as unknown as ApiTask

const sub = (id: string, extra: Partial<ApiSubtask> = {}): ApiSubtask => ({
  id, title: `Child ${id}`, kind: "explore", reviewer: false, state: "done", archived: false, report_to_parent: true,
  base_from: "project", result: null, reports: { pending: 0, queued: 0, dropped: 0 }, created_at: "x", updated_at: "x", ...extra,
})

function mount(task: ApiTask, rows: ApiSubtask[]) {
  const request = vi.fn(async (path: string) => (path.endsWith("/subtasks") ? rows : {}))
  render(<SubtasksPane task={task} />, { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: request as never })) })
  return request
}

describe("the Subtasks tab", () => {
  it("lists each child's state, kind, result and reports, and a row opens the child", async () => {
    mount(PARENT, [
      sub("ca", { result: "found the race in the queue", reports: { pending: 1, queued: 1, dropped: 0 } }),
      sub("rv", { kind: "review", reviewer: true, state: "running", report_to_parent: false }),
      sub("old", { archived: true, reports: { pending: 0, queued: 0, dropped: 2 } }),
    ])
    expect(await screen.findByText("found the race in the queue")).toBeInTheDocument()
    expect(screen.getByText("3 subtasks")).toBeInTheDocument()
    expect(screen.getByText("2 reports waiting to reach this task")).toBeInTheDocument()
    expect(screen.getByText("reviewer")).toBeInTheDocument()
    expect(screen.getByText("does not report back")).toBeInTheDocument()
    expect(screen.getByText("explore · archived")).toBeInTheDocument()
    expect(screen.getByText("2 dropped")).toBeInTheDocument()
    const before = uiIntentsFor("test-connection").taskFocusRequest()?.seq ?? 0
    fireEvent.click(screen.getByText("Child ca"))
    expect(uiIntentsFor("test-connection").taskFocusRequest()).toEqual({ taskId: "ca", seq: before + 1 })
    expect(screen.getByRole("button", { name: "New subtask" })).toBeInTheDocument()
  })

  it("offers no New subtask on a subtask, and says why", async () => {
    mount({ ...PARENT, subtask_kind: "explore", parent_task_id: "tother" } as ApiTask, [])
    expect(await screen.findByText("A subtask cannot have subtasks of its own")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "New subtask" })).toBeNull()
  })
})
