import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppErrorBoundary, PaneErrorBoundary } from "./error-boundary"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Throws once per mount — exactly what a bad turn or a malformed diagram does. */
function Thrower({ message = "boom" }: { message?: string }): null {
  throw new Error(message)
}

/** Throws until `flag.current` is flipped off, so a retry can genuinely recover. */
function Flaky({ flag }: { flag: { current: boolean } }) {
  if (flag.current) throw new Error("still broken")
  return <div>recovered</div>
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}

describe("PaneErrorBoundary", () => {
  it("renders the fallback for the pane that threw, and leaves a sibling boundary alone", () => {
    silenceConsoleError()
    render(
      <div>
        <PaneErrorBoundary label="the terminal">
          <Thrower />
        </PaneErrorBoundary>
        <PaneErrorBoundary label="the changes">
          <div>changes render fine</div>
        </PaneErrorBoundary>
      </div>,
    )
    expect(screen.getByText("Something went wrong showing the terminal.")).toBeInTheDocument()
    expect(screen.getByText("changes render fine")).toBeInTheDocument()
  })

  it("names what broke, in plain words, per pane", () => {
    silenceConsoleError()
    render(
      <PaneErrorBoundary label="this content">
        <Thrower />
      </PaneErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong showing this content.")
  })

  it("'Try again' resets the boundary and re-renders once the child recovers", () => {
    silenceConsoleError()
    const flag = { current: true }
    render(
      <PaneErrorBoundary label="the terminal">
        <Flaky flag={flag} />
      </PaneErrorBoundary>,
    )
    expect(screen.getByText("Something went wrong showing the terminal.")).toBeInTheDocument()
    flag.current = false
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByText("recovered")).toBeInTheDocument()
    expect(screen.queryByText("Something went wrong showing the terminal.")).toBeNull()
  })

  it("resets when the caller changes the boundary's key, the way a task switch does", () => {
    silenceConsoleError()
    const { rerender } = render(
      <PaneErrorBoundary key="task-a" label="the conversation">
        <Thrower message="task a's bad turn" />
      </PaneErrorBoundary>,
    )
    expect(screen.getByText("Something went wrong showing the conversation.")).toBeInTheDocument()

    rerender(
      <PaneErrorBoundary key="task-b" label="the conversation">
        <div>task b's conversation</div>
      </PaneErrorBoundary>,
    )
    expect(screen.queryByText("Something went wrong showing the conversation.")).toBeNull()
    expect(screen.getByText("task b's conversation")).toBeInTheDocument()
  })

  it("logs the caught error to the console exactly once", () => {
    const spy = silenceConsoleError()
    render(
      <PaneErrorBoundary label="the terminal">
        <Thrower message="only once" />
      </PaneErrorBoundary>,
    )
    const ownCalls = spy.mock.calls.filter(
      ([error]) => error instanceof Error && error.message === "only once",
    )
    expect(ownCalls).toHaveLength(1)
  })

  it("keeps the error message behind a closed toggle, and never shows a stack", () => {
    silenceConsoleError()
    render(
      <PaneErrorBoundary label="the terminal">
        <Thrower message="a message safe for a bug report" />
      </PaneErrorBoundary>,
    )
    expect(screen.queryByText("a message safe for a bug report")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Error details" }))
    expect(screen.getByText("a message safe for a bug report")).toBeInTheDocument()
    // no stack line ever renders, open or closed
    expect(document.body.textContent).not.toMatch(/\n\s*at /)
  })
})

describe("AppErrorBoundary", () => {
  it("offers Reload alongside Try again, and Reload reloads the page", () => {
    silenceConsoleError()
    const reload = vi.fn()
    vi.stubGlobal("location", { ...window.location, reload })
    render(
      <AppErrorBoundary>
        <Thrower />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    expect(reload).toHaveBeenCalledOnce()
  })

  it("'Try again' resets it too, without a page reload", () => {
    silenceConsoleError()
    const flag = { current: true }
    render(
      <AppErrorBoundary>
        <Flaky flag={flag} />
      </AppErrorBoundary>,
    )
    flag.current = false
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByText("recovered")).toBeInTheDocument()
  })
})
