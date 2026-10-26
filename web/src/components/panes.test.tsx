import { act, fireEvent, render, screen } from "@testing-library/react"
import { useEffect, useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { Shell as PaneShell, ToolPanel } from "./panes"

const mounts = vi.fn()
const unmounts = vi.fn()
function Shell({ name }: { name: string }) {
  useEffect(() => {
    mounts(name)
    return () => unmounts(name)
  }, [name])
  return <div>shell of {name}</div>
}

function panel(props: { terminalKey: string; toolOpen: boolean; terminalOpen: boolean }) {
  return (
    <ToolPanel
      tool={<div>the diff</div>}
      terminal={<Shell key={props.terminalKey} name={props.terminalKey} />}
      onCloseTool={() => {}}
      onCloseTerminal={() => {}}
      {...props}
    />
  )
}

describe("the tool panel", () => {
  it("does not start a task's terminal until it is first shown, then only hides it", () => {
    mounts.mockClear()
    unmounts.mockClear()
    const view = render(panel({ terminalKey: "t1", toolOpen: true, terminalOpen: false }))
    expect(mounts).not.toHaveBeenCalled()

    view.rerender(panel({ terminalKey: "t1", toolOpen: true, terminalOpen: true }))
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(screen.getByText("shell of t1")).toBeVisible()

    // closed and reopened: the same shell, never remounted
    view.rerender(panel({ terminalKey: "t1", toolOpen: true, terminalOpen: false }))
    expect(screen.getByText("shell of t1").closest("[data-tool-region]")).toHaveClass("hidden")
    view.rerender(panel({ terminalKey: "t1", toolOpen: false, terminalOpen: false }))
    view.rerender(panel({ terminalKey: "t1", toolOpen: false, terminalOpen: true }))
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
    expect(screen.getByText("shell of t1").closest("[data-tool-region]")).not.toHaveClass("hidden")
  })

  it("starts another task's terminal only once that task shows it", () => {
    mounts.mockClear()
    const view = render(panel({ terminalKey: "t1", toolOpen: false, terminalOpen: true }))
    view.rerender(panel({ terminalKey: "t2", toolOpen: true, terminalOpen: false }))
    expect(mounts.mock.calls).toEqual([["t1"]])
    view.rerender(panel({ terminalKey: "t2", toolOpen: true, terminalOpen: true }))
    expect(mounts.mock.calls).toEqual([["t1"], ["t2"]])
  })

  it("closes the tool on Esc, but not on an Esc a field inside it took", () => {
    const onCloseTool = vi.fn()
    render(
      <ToolPanel
        tool={<div><button>row</button><input aria-label="filter" /></div>}
        terminal={null}
        terminalKey="t1"
        toolOpen
        terminalOpen={false}
        onCloseTool={onCloseTool}
        onCloseTerminal={() => {}}
      />,
    )
    screen.getByLabelText("filter").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(onCloseTool).not.toHaveBeenCalled()
    screen.getByText("row").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(onCloseTool).toHaveBeenCalledOnce()
  })
})

describe("the dock's divider", () => {
  // jsdom lays nothing out; the library sizes panels from these
  function sized() {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: 420, bottom: 800, width: 420, height: 800, toJSON: () => ({}) }) as DOMRect,
    )
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800)
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(420)
    return () => [rect, height, width].forEach((spy) => spy.mockRestore())
  }

  function Harness({ initial = { tool: "changes", terminal: true } }: { initial?: { tool: string | null; terminal: boolean } }) {
    const [state, setState] = useState<{ tool: string | null; terminal: boolean }>(initial)
    return (
      <>
        <button onClick={() => setState((s) => ({ ...s, tool: "workflows" }))}>pick Workflows</button>
        <button onClick={() => setState((s) => ({ ...s, tool: "changes" }))}>open Changes</button>
        <button onClick={() => setState((s) => ({ ...s, terminal: true }))}>dock the Terminal</button>
        <output data-testid="state">{JSON.stringify(state)}</output>
        <ToolPanel
          tool={<div>{state.tool}</div>}
          terminal={<div>the shell</div>}
          terminalKey="t1"
          toolOpen={state.tool !== null}
          terminalOpen={state.terminal}
          onCloseTool={() => setState((s) => ({ ...s, tool: null }))}
          onCloseTerminal={() => setState((s) => ({ ...s, terminal: false }))}
        />
      </>
    )
  }

  const growOf = (id: string) => Number(document.getElementById(id)!.style.flexGrow)

  it("collapsing the upper tool closes it, so the next tool picked shows", async () => {
    const restore = sized()
    try {
      render(<Harness />)
      await act(async () => {})
      expect(growOf("tool")).toBeGreaterThan(0)
      const divider = screen.getByRole("separator")
      divider.focus()
      // the keyboard's way of dragging the divider all the way up
      await act(async () => void fireEvent.keyDown(divider, { key: "Home" }))
      expect(growOf("tool")).toBe(0)
      expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({ tool: null, terminal: true })

      fireEvent.click(screen.getByText("pick Workflows"))
      await act(async () => {})
      expect(growOf("tool")).toBeGreaterThan(0)
      expect(screen.getByText("workflows")).toBeVisible()
    } finally {
      restore()
    }
  })

  // The divider is disabled while the dock is not docked, and the library
  // registers a divider once: enabling it later must still make it work.
  // The ordinary sequence: start closed, open Changes, dock the Terminal.
  it("a divider enabled by docking resizes from the keyboard", async () => {
    const restore = sized()
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener("error", onError)
    try {
      render(<Harness initial={{ tool: null, terminal: false }} />)
      await act(async () => {})
      fireEvent.click(screen.getByText("open Changes"))
      await act(async () => {})
      fireEvent.click(screen.getByText("dock the Terminal"))
      await act(async () => {})
      const divider = screen.getByRole("separator")
      divider.focus()

      // the arrows move it (the tool opens at its minimum, so down first)
      const before = growOf("tool")
      await act(async () => void fireEvent.keyDown(divider, { key: "ArrowDown" }))
      expect(growOf("tool")).toBeGreaterThan(before)
      await act(async () => void fireEvent.keyDown(divider, { key: "ArrowUp" }))
      expect(growOf("tool")).toBeCloseTo(before)
      expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({ tool: "changes", terminal: true })

      await act(async () => void fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" }))
      expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({ tool: null, terminal: true })
      fireEvent.click(screen.getByText("pick Workflows"))
      await act(async () => {})
      expect(growOf("tool")).toBeGreaterThan(0)
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener("error", onError)
      restore()
    }
  })

  it("the panel's own divider, enabled by opening the panel, shuts it from the keyboard", async () => {
    const restore = sized()
    const shut = vi.fn()
    const shell = (open: boolean) => (
      <PaneShell sidebar={<div />} centre={<div />} panel={<div>tools</div>} panelOpen={open} onPanelDraggedShut={shut} />
    )
    try {
      const view = render(shell(false))
      await act(async () => {})
      view.rerender(shell(true))
      await act(async () => {})
      const divider = screen.getAllByRole("separator").find((s) => s.nextElementSibling?.id === "tool")!
      divider.focus()
      await act(async () => void fireEvent.keyDown(divider, { key: "End" }))
      expect(shut).toHaveBeenCalledOnce()
    } finally {
      restore()
    }
  })

  it("collapsing the docked Terminal closes it, and the tool keeps the panel", async () => {
    const restore = sized()
    try {
      render(<Harness />)
      await act(async () => {})
      const divider = screen.getByRole("separator")
      divider.focus()
      await act(async () => void fireEvent.keyDown(divider, { key: "End" }))
      expect(JSON.parse(screen.getByTestId("state").textContent!)).toEqual({ tool: "changes", terminal: false })
      expect(growOf("tool")).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })
})
