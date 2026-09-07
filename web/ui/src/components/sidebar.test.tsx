import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"

function mount(touch: boolean, onOpenSettings: () => void) {
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
})
