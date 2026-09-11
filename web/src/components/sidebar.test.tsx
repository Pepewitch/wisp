import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"
import { inertProjectSearch } from "@/test/project-search"

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
