import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useDesktopTaskNavigation } from "./useDesktopTaskNavigation"
import { useSidebarTree } from "./useSidebarTree"
import type { ApiTask } from "@/lib/types"

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
    useDesktopTaskNavigation(enabled, ["first", "second", "last"], selectedId, onSelect)
    return null
  }
  const view = render(<Harness />)
  return { onSelect, view }
}

function task(id: string, extra: Record<string, unknown> = {}): ApiTask {
  return { id, title: id, repo_path: "/one", state: "done", archived: false, parent_task_id: null, subtask_kind: null, created_at: "2026-10-01", updated_at: "2026-10-01", ...extra } as unknown as ApiTask
}

/** The ids Ctrl+Tab steps through for these tasks, grouped by project as the sidebar does. */
function sidebarIds(tasks: ApiTask[], selectedId: string | null = null, nest = true): string[] {
  localStorage.clear()
  let ids: string[] = []
  function Harness() {
    ids = useSidebarTree({ connectionId: "local", tasks, repos: [], nest, selectedId }).visibleIds
    return null
  }
  render(<Harness />).unmount()
  return ids
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
    const ids = sidebarIds([
      task("project-one"),
      task("project-two", { repo_path: "/two" }),
      task("archived", { archived: true, cleanup: { state: "complete" } }),
      task("cleanup", { archived: true, cleanup: { state: "needs-attention" } }),
    ])
    expect(ids).toEqual(["project-one", "project-two", "cleanup", "archived"])
  })

  it("steps over a collapsed parent's subtasks, and into an open one's", () => {
    const tasks = [task("parent"), task("child", { parent_task_id: "parent", subtask_kind: "explore" }), task("other", { updated_at: "2026-01-01" })]
    expect(sidebarIds(tasks)).toEqual(["parent", "other"])
    // selecting the child opens its parent, the same as a click on the disclosure
    expect(sidebarIds(tasks, "child")).toEqual(["parent", "child", "other"])
    // an older daemon: flat
    expect(sidebarIds(tasks, null, false)).toEqual(["parent", "child", "other"])
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
