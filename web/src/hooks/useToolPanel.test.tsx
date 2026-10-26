import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { connectionStorageKey } from "@/lib/connection-storage"
import type { ToolName } from "@/lib/tools"
import { uiIntentsFor } from "@/lib/ui-intents"

import { CLOSED, useToolPanel, useToolPanelShortcuts, type ToolPanelControls } from "./useToolPanel"

const ALL: ToolName[] = ["terminal", "changes", "autopilot", "subtasks", "workflows"]

function panel(taskId: string | null, available: ToolName[] | null = ALL, connectionId = "conn") {
  return renderHook((props: { taskId: string | null; available: ToolName[] | null }) =>
    useToolPanel({ connectionId, taskId: props.taskId, available: props.available }),
  { initialProps: { taskId, available } })
}

beforeEach(() => localStorage.clear())

describe("the tool panel's per-task memory", () => {
  it("starts closed, and an icon opens its tool and closes it again", () => {
    const { result } = panel("t1")
    expect(result.current.layout).toEqual(CLOSED)
    expect(result.current.open).toBe(false)
    act(() => result.current.toggle("changes"))
    expect(result.current.layout).toEqual({ tool: "changes", terminal: false })
    act(() => result.current.toggle("changes"))
    expect(result.current.layout).toEqual(CLOSED)
  })

  it("shows one tool at a time, and docks the Terminal below it", () => {
    const { result } = panel("t1")
    act(() => result.current.toggle("changes"))
    act(() => result.current.toggle("autopilot"))
    expect(result.current.layout).toEqual({ tool: "autopilot", terminal: false })
    act(() => result.current.toggle("terminal"))
    expect(result.current.layout).toEqual({ tool: "autopilot", terminal: true })
    // closing the tool leaves the Terminal, alone
    act(() => result.current.toggle("autopilot"))
    expect(result.current.layout).toEqual({ tool: null, terminal: true })
  })

  it("restores each task's tool when you come back to it, and after a reload", () => {
    const { result, rerender, unmount } = panel("t1")
    act(() => result.current.toggle("workflows"))
    rerender({ taskId: "t2", available: ALL })
    expect(result.current.layout).toEqual(CLOSED)
    act(() => result.current.toggle("terminal"))
    rerender({ taskId: "t1", available: ALL })
    expect(result.current.layout).toEqual({ tool: "workflows", terminal: false })
    unmount()

    const again = panel("t2")
    expect(again.result.current.layout).toEqual({ tool: null, terminal: true })
  })

  it("keeps each connection's tasks apart", () => {
    const local = panel("t1", ALL, "local")
    act(() => local.result.current.toggle("changes"))
    expect(localStorage.getItem(connectionStorageKey("local", "tool_panel"))).toContain("changes")
    expect(panel("t1", ALL, "remote").result.current.layout).toEqual(CLOSED)
  })

  it("⌘\\ closes everything, then reopens what the task last had", () => {
    const { result } = panel("t1")
    act(() => result.current.toggle("changes"))
    act(() => result.current.toggle("terminal"))
    act(() => result.current.togglePanel())
    expect(result.current.layout).toEqual(CLOSED)
    act(() => result.current.togglePanel())
    expect(result.current.layout).toEqual({ tool: "changes", terminal: true })
  })

  it("⌘\\ on a task that never had a tool opens its changes", () => {
    const { result } = panel("t1")
    act(() => result.current.togglePanel())
    expect(result.current.layout).toEqual({ tool: "changes", terminal: false })
  })

  it("never opens a tool this daemon does not have, and drops a remembered one", () => {
    const { result, rerender } = panel("t1")
    act(() => result.current.toggle("autopilot"))
    rerender({ taskId: "t1", available: ["terminal", "changes"] })
    expect(result.current.layout).toEqual(CLOSED)
    act(() => result.current.toggle("workflows"))
    expect(result.current.layout).toEqual(CLOSED)
  })

  it("the palette's verbs open and stay open", () => {
    const { result } = panel("t1")
    act(() => result.current.show("changes"))
    act(() => result.current.show("changes"))
    expect(result.current.layout).toEqual({ tool: "changes", terminal: false })
  })

  it("lets the shell take the keyboard once after the person opens the Terminal, and never from a task switch", () => {
    const { result, rerender } = panel("t1")
    expect(result.current.claimTerminalFocus()).toBe(false)
    act(() => result.current.toggle("terminal"))
    expect(result.current.claimTerminalFocus()).toBe(true)
    expect(result.current.claimTerminalFocus()).toBe(false)
    // t1 keeps its Terminal open; coming back to it is not opening it
    rerender({ taskId: "t2", available: ALL })
    rerender({ taskId: "t1", available: ALL })
    expect(result.current.claimTerminalFocus()).toBe(false)
    // an unclaimed open does not follow you to another task
    act(() => result.current.close("terminal"))
    act(() => result.current.toggle("terminal"))
    rerender({ taskId: "t2", available: ALL })
    expect(result.current.claimTerminalFocus()).toBe(false)
  })

  it("hands the keyboard to the composer when the region holding it closes", () => {
    const focusComposer = vi.spyOn(uiIntentsFor("conn"), "focusComposer")
    const region = document.createElement("div")
    region.setAttribute("data-tool-region", "terminal")
    const field = document.createElement("textarea")
    region.append(field)
    document.body.append(region)
    field.focus()
    const { result } = panel("t1")
    act(() => result.current.toggle("terminal"))
    expect(focusComposer).not.toHaveBeenCalled()
    act(() => result.current.toggle("terminal"))
    expect(focusComposer).toHaveBeenCalledOnce()
    region.remove()
    focusComposer.mockRestore()
  })
})

describe("the tool panel's chords", () => {
  const controls = () => ({ toggle: vi.fn(), togglePanel: vi.fn() }) as unknown as ToolPanelControls
  const press = (init: KeyboardEventInit, target: EventTarget = window) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  afterEach(() => document.body.replaceChildren())

  it("⌃` toggles the Terminal, from anywhere, the shell included", () => {
    const c = controls()
    renderHook(() => useToolPanelShortcuts(c, true))
    const shell = document.body.appendChild(document.createElement("div"))
    shell.setAttribute("data-terminal", "")
    const event = press({ key: "`", code: "Backquote", ctrlKey: true }, shell)
    expect(c.toggle).toHaveBeenCalledWith("terminal")
    expect(event.defaultPrevented).toBe(true)
  })

  it("⌘\\ toggles the panel on Apple platforms, even from the shell", () => {
    const c = controls()
    renderHook(() => useToolPanelShortcuts(c, true))
    const shell = document.body.appendChild(document.createElement("div"))
    shell.setAttribute("data-terminal", "")
    press({ key: "\\", code: "Backslash", metaKey: true }, shell)
    expect(c.togglePanel).toHaveBeenCalledOnce()
  })

  it("leaves Ctrl+\\ to a focused shell off Apple platforms, where it is SIGQUIT", () => {
    const c = controls()
    renderHook(() => useToolPanelShortcuts(c, false))
    const shell = document.body.appendChild(document.createElement("div"))
    shell.setAttribute("data-terminal", "")
    const inShell = press({ key: "\\", code: "Backslash", ctrlKey: true }, shell)
    expect(c.togglePanel).not.toHaveBeenCalled()
    expect(inShell.defaultPrevented).toBe(false)
    press({ key: "\\", code: "Backslash", ctrlKey: true })
    expect(c.togglePanel).toHaveBeenCalledOnce()
  })

  it("installs nothing without a task's controls", () => {
    const add = vi.spyOn(window, "addEventListener")
    renderHook(() => useToolPanelShortcuts(null, true))
    expect(add).not.toHaveBeenCalledWith("keydown", expect.anything())
    add.mockRestore()
  })
})
