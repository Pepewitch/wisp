import { render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { describe, expect, it, vi } from "vitest"

import { ToolPanel } from "./panes"

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
      />,
    )
    screen.getByLabelText("filter").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(onCloseTool).not.toHaveBeenCalled()
    screen.getByText("row").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(onCloseTool).toHaveBeenCalledOnce()
  })
})
