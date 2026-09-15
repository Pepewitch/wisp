import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  sidebarTaskIds,
  useDesktopTaskNavigation,
} from "./useDesktopTaskNavigation"

function mount({
  enabled = true,
  selectedId = "second",
  onSelect = vi.fn(),
}: {
  enabled?: boolean
  selectedId?: string | null
  onSelect?: (taskId: string) => void
} = {}) {
  function Harness() {
    useDesktopTaskNavigation(
      enabled,
      [
        {
          tasks: [{ id: "first" }, { id: "second" }, { id: "last" }],
        },
      ],
      [],
      selectedId,
      onSelect
    )
    return null
  }
  const view = render(<Harness />)
  return { onSelect, view }
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    ...init,
    cancelable: true,
    bubbles: true,
  })
  window.dispatchEvent(event)
  return event
}

describe("desktop task navigation", () => {
  it("follows the sidebar order across projects and archive sections", () => {
    expect(
      sidebarTaskIds(
        [{ tasks: [{ id: "project-one" }] }, { tasks: [{ id: "project-two" }] }],
        [
          { id: "archived", cleanup: { state: "complete" } },
          { id: "cleanup", cleanup: { state: "needs-attention" } },
        ]
      )
    ).toEqual(["project-one", "project-two", "cleanup", "archived"])
  })

  it("moves down with Ctrl+Tab and up with Ctrl+Shift+Tab", () => {
    const down = mount()
    const downEvent = press({ key: "Tab", ctrlKey: true })
    expect(down.onSelect).toHaveBeenCalledWith("last")
    expect(downEvent.defaultPrevented).toBe(true)
    down.view.unmount()

    const up = mount()
    press({ key: "Tab", ctrlKey: true, shiftKey: true })
    expect(up.onSelect).toHaveBeenCalledWith("first")
  })

  it("wraps from the last task to the first and from the first to the last", () => {
    const down = mount({ selectedId: "last" })
    press({ key: "Tab", ctrlKey: true })
    expect(down.onSelect).toHaveBeenCalledWith("first")
    down.view.unmount()

    const up = mount({ selectedId: "first" })
    press({ key: "Tab", ctrlKey: true, shiftKey: true })
    expect(up.onSelect).toHaveBeenCalledWith("last")
  })

  it("leaves Ctrl+Tab to the browser outside the desktop app", () => {
    const browser = mount({ enabled: false })
    const event = press({ key: "Tab", ctrlKey: true })

    expect(browser.onSelect).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("ignores similar chords with Alt or Command", () => {
    const navigation = mount()
    const alt = press({ key: "Tab", ctrlKey: true, altKey: true })
    const command = press({ key: "Tab", ctrlKey: true, metaKey: true })

    expect(navigation.onSelect).not.toHaveBeenCalled()
    expect(alt.defaultPrevented).toBe(false)
    expect(command.defaultPrevented).toBe(false)
  })
})
