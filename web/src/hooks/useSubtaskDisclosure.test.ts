import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import { connectionStorageKey } from "@/lib/connection-storage"
import { useSubtaskDisclosure } from "./useSubtaskDisclosure"

const tasks = [
  { id: "p", parent_task_id: null },
  { id: "c", parent_task_id: "p" },
  { id: "r", parent_task_id: "c" },
  { id: "q", parent_task_id: null },
  { id: "d", parent_task_id: "q" },
]

const render = (selectedId: string | null, connectionId = "local") =>
  renderHook((props: { selectedId: string | null; connectionId: string }) => useSubtaskDisclosure(props.connectionId, tasks, props.selectedId), {
    initialProps: { selectedId, connectionId },
  })

describe("useSubtaskDisclosure", () => {
  beforeEach(() => localStorage.clear())

  it("starts collapsed, toggles, and remembers per connection", () => {
    const { result, unmount } = render(null)
    expect(result.current.isOpen("p")).toBe(false)
    act(() => result.current.toggle("p"))
    expect(result.current.isOpen("p")).toBe(true)
    expect(JSON.parse(localStorage.getItem(connectionStorageKey("local", "subtasks_open"))!)).toEqual(["p"])
    unmount()
    expect(render(null).result.current.isOpen("p")).toBe(true)
    expect(render(null, "remote-1").result.current.isOpen("p")).toBe(false)
  })

  it("opens every parent above a selected child, from whichever source selected it", () => {
    const { result, rerender } = render(null)
    rerender({ selectedId: "r", connectionId: "local" })
    expect(["p", "c", "q"].map(result.current.isOpen)).toEqual([true, true, false])
    rerender({ selectedId: "d", connectionId: "local" })
    expect(result.current.isOpen("q")).toBe(true)
  })

  it("lets a person collapse a parent again while its child stays selected", () => {
    const { result, rerender } = render("c")
    expect(result.current.isOpen("p")).toBe(true)
    act(() => result.current.toggle("p"))
    rerender({ selectedId: "c", connectionId: "local" })
    expect(result.current.isOpen("p")).toBe(false)
  })

  it("reads a damaged stored value as nothing open", () => {
    localStorage.setItem(connectionStorageKey("local", "subtasks_open"), "{not json")
    expect(render(null).result.current.isOpen("p")).toBe(false)
  })
})
