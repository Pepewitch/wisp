import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"

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
