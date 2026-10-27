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

  it("a tool the divider closed reopens at its docked height, not its minimum", async () => {
    const restore = sized()
    try {
      render(<Harness />)
      await act(async () => {})
      const docked = growOf("tool")
      const divider = screen.getByRole("separator")
      divider.focus()
      await act(async () => void fireEvent.keyDown(divider, { key: "Home" }))
      expect(growOf("tool")).toBe(0)

      fireEvent.click(screen.getByText("pick Workflows"))
      await act(async () => {})
      expect(growOf("tool")).toBeCloseTo(docked)
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

  it("remembers the width a keypress left the panel at, not the one before it", async () => {
    // a window wide enough for the sidebar, the centre and the panel; the
    // panel's pixels follow its laid-out share, the way a browser's do
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 800, width: 1600, height: 800, toJSON: () => ({}) }) as DOMRect,
    )
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      const share = this.style.flexGrow === "" ? 100 / 3 : Number(this.style.flexGrow)
      return Math.round((share / 100) * 1600)
    })
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800)
    // the library orders panels by where they sit before it sizes them
    const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return [...(this.parentElement?.children ?? [])].indexOf(this)
    })
    const shell = (open: boolean) => <PaneShell sidebar={<div />} centre={<div />} panel={<div>tools</div>} panelOpen={open} />
    try {
      localStorage.removeItem("wisp_tool_panel_width")
      const view = render(shell(false))
      await act(async () => {})
      view.rerender(shell(true))
      await act(async () => {})
      const divider = screen.getAllByRole("separator").find((s) => s.nextElementSibling?.id === "tool")!
      divider.focus()
      await act(async () => void fireEvent.keyDown(divider, { key: "ArrowLeft" }))
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      const now = document.getElementById("tool")!.offsetWidth
      expect(Number(localStorage.getItem("wisp_tool_panel_width"))).toBe(now)
    } finally {
      ;[rect, width, height, left].forEach((spy) => spy.mockRestore())
      localStorage.removeItem("wisp_tool_panel_width")
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

describe("the panel's glide", () => {
  /** a 1600px window whose panels' pixels follow their laid-out share, on a screen that allows motion */
  function laidOut() {
    const spies = [
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 800, width: 1600, height: 800, toJSON: () => ({}) }) as DOMRect,
      ),
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        const share = this.style.flexGrow === "" ? 100 / 3 : Number(this.style.flexGrow)
        return Math.round((share / 100) * 1600)
      }),
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800),
      vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return [...(this.parentElement?.children ?? [])].indexOf(this)
      }),
    ]
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    return () => {
      spies.forEach((spy) => spy.mockRestore())
      vi.unstubAllGlobals()
      localStorage.removeItem("wisp_tool_panel_width")
    }
  }
  const outer = () => document.getElementById("sidebar")!.parentElement!
  const toolPanel = () => [...outer().children].filter((child) => child.hasAttribute("data-panel")).at(-1)!
  const landed = () => act(() => void fireEvent.transitionEnd(toolPanel(), { propertyName: "flex-grow" }))

  it("tells the centre where it will land, pins the tool's width, and keeps the tool on screen while it shuts", async () => {
    const restore = laidOut()
    const settling = vi.fn()
    const shell = (open: boolean) => (
      <PaneShell
        sidebar={<div />}
        centre={<div />}
        panel={panel({ terminalKey: "t", toolOpen: open, terminalOpen: false })}
        panelOpen={open}
        onCentreSettling={settling}
      />
    )
    try {
      localStorage.setItem("wisp_tool_panel_width", "400")
      const view = render(shell(false))
      await act(async () => {})
      settling.mockClear()
      view.rerender(shell(true))
      await act(async () => {})
      expect(outer()).toHaveAttribute("data-glide", "in")
      // the content is laid out once, at the width it lands at, not on every frame
      expect(outer().style.getPropertyValue("--tool-pin")).toMatch(/^\d+(\.\d+)?px$/)
      const [[centre]] = settling.mock.calls as [[number]]
      expect(centre).toBeGreaterThan(0)
      expect(centre).toBeLessThan(1600 - 400)
      await landed()
      expect(outer()).not.toHaveAttribute("data-glide")
      expect(settling).toHaveBeenLastCalledWith(null)

      view.rerender(shell(false))
      await act(async () => {})
      expect(outer()).toHaveAttribute("data-glide", "out")
      // what slides out is the tool, not an empty box; nothing in it takes a click
      expect(document.querySelector('[data-tool-region="tool"]')).not.toHaveClass("hidden")
      expect(document.querySelector("[data-tool-pin]")).toHaveAttribute("inert")
      await landed()
      expect(document.querySelector('[data-tool-region="tool"]')).toHaveClass("hidden")
    } finally {
      restore()
    }
  })

  it("does not glide, pin or hold anything under reduced motion", async () => {
    const settling = vi.fn()
    const shell = (open: boolean) => (
      <PaneShell sidebar={<div />} centre={<div />} panel={panel({ terminalKey: "t", toolOpen: open, terminalOpen: false })} panelOpen={open} onCentreSettling={settling} />
    )
    // jsdom has no matchMedia, which reads as reduced motion
    const view = render(shell(true))
    await act(async () => {})
    view.rerender(shell(false))
    await act(async () => {})
    expect(outer()).not.toHaveAttribute("data-glide")
    expect(document.querySelector('[data-tool-region="tool"]')).toHaveClass("hidden")
    expect(settling.mock.calls.every(([px]) => px === null)).toBe(true)
  })
})

describe("the sidebar's divider", () => {
  // As much of a browser's layout as the library reads: the shell's children
  // sit side by side in a 1600px row, a panel as wide as its flex-grow share,
  // a divider one pixel; an undisplayed element has no box, so it reads 0.
  // jsdom has no Tailwind, so `hidden` is declared here.
  const WIDTH = 1600
  function laidOut() {
    const style = document.createElement("style")
    style.textContent = ".hidden { display: none }"
    document.head.append(style)
    const boxWidth = (el: HTMLElement) => {
      if (getComputedStyle(el).display === "none") return 0
      if (el.hasAttribute("data-panel")) {
        const share = el.style.flexGrow === "" ? 100 / 3 : Number(el.style.flexGrow)
        return Math.round((share / 100) * WIDTH)
      }
      return el.getAttribute("role") === "separator" ? 1 : WIDTH
    }
    const boxLeft = (el: HTMLElement) => {
      if (getComputedStyle(el).display === "none") return 0
      const siblings = [...(el.parentElement?.children ?? [])]
      return siblings.slice(0, siblings.indexOf(el)).reduce((sum, sibling) => sum + boxWidth(sibling as HTMLElement), 0)
    }
    const spies = [
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return boxWidth(this)
      }),
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800),
      vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return boxLeft(this)
      }),
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const x = boxLeft(this)
        const width = boxWidth(this)
        return { x, y: 0, left: x, top: 0, right: x + width, bottom: 800, width, height: 800, toJSON: () => ({}) } as DOMRect
      }),
    ]
    return () => {
      spies.forEach((spy) => spy.mockRestore())
      style.remove()
    }
  }

  const sidebarWidth = () => (Number(document.getElementById("sidebar")!.style.flexGrow) / 100) * WIDTH
  const divider = () => document.getElementById("sidebar")!.nextElementSibling as HTMLElement
  // the tool panel closed, as every task opens
  const shell = () => <PaneShell sidebar={<div />} centre={<div />} panel={<div>tools</div>} panelOpen={false} />

  async function withShell(run: (errors: unknown[]) => Promise<void>) {
    // a saved sidebar with room to move both ways
    localStorage.setItem("react-resizable-panels:wisp-ui-main-v2", JSON.stringify({ sidebar: 18.75, centre: 81.25, tool: 0 }))
    const restore = laidOut()
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => errors.push(event.error)
    window.addEventListener("error", onError)
    try {
      await run(errors)
    } finally {
      window.removeEventListener("error", onError)
      restore()
      localStorage.removeItem("react-resizable-panels:wisp-ui-main-v2")
    }
  }

  it("resizes the sidebar from the keyboard, and the width survives a reload", async () => {
    await withShell(async (errors) => {
      const view = render(shell())
      await act(async () => {})
      const before = sidebarWidth()
      divider().focus()
      await act(async () => void fireEvent.keyDown(divider(), { key: "ArrowRight" }))
      expect(sidebarWidth()).toBeGreaterThan(before)
      await act(async () => void fireEvent.keyDown(divider(), { key: "ArrowLeft" }))
      expect(sidebarWidth()).toBeCloseTo(before)
      await act(async () => void fireEvent.keyDown(divider(), { key: "End" }))
      expect(sidebarWidth()).toBeCloseTo(380)
      await act(async () => void fireEvent.keyDown(divider(), { key: "Home" }))
      expect(sidebarWidth()).toBeCloseTo(220)
      expect(errors).toEqual([])

      // the library saves a beat after the last change
      await act(() => new Promise((resolve) => setTimeout(resolve, 150)))
      view.unmount()
      render(shell())
      await act(async () => {})
      expect(sidebarWidth()).toBeCloseTo(220)
    })
  })

  it("follows a pointer dragging it", async () => {
    await withShell(async () => {
      render(shell())
      await act(async () => {})
      const before = sidebarWidth()
      const at = divider().getBoundingClientRect().x
      fireEvent.pointerDown(divider(), { pointerType: "mouse", button: 0, buttons: 1, clientX: at, clientY: 400 })
      await act(async () => void fireEvent.pointerMove(document, { pointerType: "mouse", buttons: 1, clientX: at + 60, clientY: 400 }))
      await act(async () => void fireEvent.pointerUp(document, { pointerType: "mouse", button: 0, clientX: at + 60, clientY: 400 }))
      expect(sidebarWidth()).toBeCloseTo(before + 60, 0)
    })
  })
})
