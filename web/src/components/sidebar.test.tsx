import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"
import { useSidebarTree } from "@/hooks/useSidebarTree"
import type { ApiTask } from "@/lib/types"
import { inertProjectSearch } from "@/test/project-search"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

function mount(touch: boolean, onOpenSettings: () => void, updateControl?: ReactNode) {
  return render(
    <Sidebar
      groups={[]}
      archivedTasks={[]}
      status={{}}
      pullRequests={{}}
      selectedId={null}
      onSelect={() => {}}
      showArchived={false}
      onShowArchivedChange={() => {}}
      onNewTask={() => {}}
      onConfigureProject={() => {}}
      search={inertProjectSearch()}
      onOpenSettings={onOpenSettings}
      updateControl={updateControl}
      error={null}
      loading={false}
      touch={touch}
    />,
  )
}

describe("the sidebar footer", () => {
  it("carries the settings gear on touch, where there is no top bar", () => {
    const open = vi.fn()
    mount(true, open)

    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(open).toHaveBeenCalledOnce()
  })

  it("leaves it out on pointer, where the top bar already has one", () => {
    mount(false, vi.fn())

    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull()
    expect(screen.getByRole("switch", { name: "Show archived" })).toBeInTheDocument()
  })

  it("carries Wisp's update surface on touch, which has no top bar to hold it", () => {
    mount(true, vi.fn(), <span>Update daemon 0.4.1</span>)

    expect(screen.getByText("Update daemon 0.4.1")).toBeInTheDocument()
  })

  it("leaves it out on pointer, where the top bar already renders it", () => {
    mount(false, vi.fn(), <span>Update daemon 0.4.1</span>)

    expect(screen.queryByText("Update daemon 0.4.1")).toBeNull()
  })
})

/** A project group with the shape `groupTasksByProject` produces. */
function group(tasks: never[] = []) {
  return { path: "/src/wisp", name: "wisp", exists: true, unlisted: false, tasks }
}

function mountPane(props: Partial<Parameters<typeof Sidebar>[0]>) {
  return render(
    <Sidebar
      groups={[]}
      archivedTasks={[]}
      status={{}}
      pullRequests={{}}
      selectedId={null}
      onSelect={() => {}}
      showArchived={false}
      onShowArchivedChange={() => {}}
      onNewTask={() => {}}
      onConfigureProject={() => {}}
      search={inertProjectSearch()}
      error={null}
      loading={false}
      {...props}
    />,
  )
}

describe("an empty pane ends in the control, not in a noun", () => {
  it("offers Add project to a client that can register one", () => {
    const onAddProject = vi.fn()
    mountPane({ onAddProject })

    // the pane header's icon button carries the same verb; this is the one in
    // the placeholder, which is the only one a first-time reader will see
    fireEvent.click(screen.getByRole("button", { name: "Add project…" }))
    expect(onAddProject).toHaveBeenCalledOnce()
  })

  it("keeps the CLI sentence — and no dead button — when it cannot", () => {
    mountPane({ onAddProject: undefined })

    expect(screen.getByText(/wisp project add/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add project…" })).toBeNull()
  })

  it("turns a project's empty task list into the way to fill it", () => {
    const onNewTask = vi.fn()
    mountPane({ groups: [group()], onNewTask })

    fireEvent.click(screen.getByRole("button", { name: /No tasks yet/ }))
    expect(onNewTask).toHaveBeenCalledWith("/src/wisp")
  })
})

describe("the error row carries its own repair", () => {
  it("runs the action the caller chose for this failure", () => {
    const onClick = vi.fn()
    mountPane({ error: "tasks: fetch failed", errorAction: { label: "Set up", onClick } })

    expect(screen.getByText("tasks: fetch failed")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Set up" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("stays a plain line when there is nothing to offer", () => {
    mountPane({ error: "tasks: fetch failed" })

    expect(screen.getByText("tasks: fetch failed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })
})

describe("a project's verification control", () => {
  const summary = { state: "active" as const, areas: 3, draft: false, attention: false, busy: false }

  it("hides until hover with nothing to say, and is absent on a daemon without auto-review", () => {
    const { unmount } = mountPane({ groups: [{ ...group(), verification: summary }], verification: true })
    const quiet = screen.getByRole("button", { name: "Verification: 3 areas — wisp" })
    expect(quiet).toHaveAttribute("title", "Verification: 3 areas")
    expect(quiet.className).toContain("hidden")
    unmount()
    mountPane({ groups: [{ ...group(), verification: summary }], verification: false })
    expect(screen.queryByRole("button", { name: /^Verification/ })).toBeNull()
  })

  it("stays on screen with a dot when it has something to say, and opens the settings at Verification", () => {
    const onConfigureProject = vi.fn()
    mountPane({ groups: [{ ...group(), verification: { ...summary, attention: true, draft: true } }], verification: true, onConfigureProject })
    const loud = screen.getByRole("button", { name: "Verification needs attention — wisp" })
    expect(loud.className).not.toContain("hidden")
    expect(loud.querySelector(".bg-destructive")).not.toBeNull()
    fireEvent.click(loud)
    expect(onConfigureProject).toHaveBeenCalledWith("/src/wisp", "verification")
  })
})

describe("subtasks in the sidebar", () => {
  const at = "2026-10-01T08:00:00Z"
  const row = (id: string, extra: Partial<ApiTask> = {}) =>
    ({ id, title: `Task ${id}`, repo_path: "/src/wisp", state: "done", archived: false, parent_task_id: null, subtask_kind: null, created_at: at, updated_at: at, background: { state: "none" }, ...extra }) as ApiTask
  const tasks = [
    row("parent"),
    row("child", { parent_task_id: "parent", subtask_kind: "explore", state: "needs-input" }),
    row("reviewer", { parent_task_id: "child", subtask_kind: "review", verify_role: "reviewer", state: "running" }),
    row("orphan", { subtask_kind: "review" }),
  ]

  function Nested({ touch = false, nest = true, selectedId = null, more = [] }: { touch?: boolean; nest?: boolean; selectedId?: string | null; more?: ApiTask[] }) {
    const { groups, archivedTasks, ...tree } = useSidebarTree({ connectionId: "test-connection", tasks: [...tasks, ...more], repos: [], nest, selectedId })
    return (
      <Sidebar
        groups={groups}
        archivedTasks={archivedTasks}
        tree={tree}
        status={{}}
        pullRequests={{}}
        selectedId={selectedId}
        onSelect={() => {}}
        showArchived={false}
        onShowArchivedChange={() => {}}
        onNewTask={() => {}}
        onConfigureProject={() => {}}
        search={inertProjectSearch()}
        error={null}
        loading={false}
        touch={touch}
      />
    )
  }
  const mountNested = (props: Parameters<typeof Nested>[0] = {}) =>
    render(<Nested {...props} />, { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection")) })
  const rows = () => [...document.querySelectorAll("[data-task-id]")].map((el) => el.getAttribute("data-task-id"))

  afterEach(() => localStorage.clear())

  it("starts collapsed with a count and a rollup, and opens from its own button without selecting", () => {
    mountNested()
    expect(rows()).toEqual(["parent", "orphan"])
    const disclosure = screen.getByRole("button", { name: "Show 1 subtask of Task parent" })
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    // the child needs input; the reviewer under it runs: needs-input wins the dot
    expect(screen.getByRole("img", { name: "a subtask needs input" })).toBeInTheDocument()
    expect(screen.getByText("parent deleted")).toBeInTheDocument()
    expect(disclosure.closest("button[data-task-id]")).toBeNull()
    fireEvent.click(disclosure)
    expect(rows()).toEqual(["parent", "child", "orphan"])
    fireEvent.click(screen.getByRole("button", { name: "Show 1 subtask of Task child" }))
    expect(rows()).toEqual(["parent", "child", "reviewer", "orphan"])
  })

  it("opens the parents above a selected child", () => {
    mountNested({ selectedId: "reviewer" })
    expect(rows()).toEqual(["parent", "child", "reviewer", "orphan"])
  })

  it("keeps every row's dot in one column, in a project with no parent too", () => {
    mountNested({ more: [row("plain", { repo_path: "/src/other" })] })
    const inset = (id: string) => document.querySelector(`button[data-task-id="${id}"]`)!.className.split(" ").filter((c) => c.startsWith("pl-"))
    expect(inset("parent")).toEqual(["pl-[26px]"])
    expect(inset("orphan")).toEqual(inset("parent"))
    expect(inset("plain")).toEqual(inset("parent"))
  })

  it("gives the disclosure its own 44px target on touch", () => {
    mountNested({ touch: true })
    expect(screen.getByRole("button", { name: "Show 1 subtask of Task parent" }).className).toContain("size-11")
  })

  it("is flat on a daemon without subtasks", () => {
    mountNested({ nest: false })
    expect(rows()).toEqual(["parent", "child", "reviewer", "orphan"])
    expect(screen.queryByRole("button", { name: /^Show 1 subtask/ })).toBeNull()
  })
})
