import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Prose } from "./prose"

/**
 * `Prose` renders whatever a harness sent through Streamdown, Mermaid fence
 * and all (DEBT-01). This file forces that render to throw — something
 * malformed markdown or an adapter's `Record<string, any>` payload can
 * genuinely do — to prove the block-level boundary in `prose.tsx` catches it
 * without the isolation `prose.test.tsx` already covers for the happy path.
 */
vi.mock("streamdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("streamdown")>()
  const Real = actual.Streamdown
  return {
    ...actual,
    Streamdown: (props: React.ComponentProps<typeof Real>) => {
      if (props.children === "boom") throw new Error("malformed markdown from the harness")
      return <Real {...props} />
    },
  }
})

afterEach(() => vi.restoreAllMocks())

describe("Prose's own error boundary", () => {
  it("degrades one bad block while a sibling block keeps rendering", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <div>
        <Prose text="boom" />
        <Prose text="a normal reply" />
      </div>,
    )
    expect(screen.getByText("Something went wrong showing this content.")).toBeInTheDocument()
    expect(screen.getByText("a normal reply")).toBeInTheDocument()
  })

  it("'Try again' re-renders once the same text is given another chance", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { rerender } = render(<Prose text="boom" />)
    expect(screen.getByText("Something went wrong showing this content.")).toBeInTheDocument()

    rerender(<Prose text="fixed now" />)
    // the boundary is not remounted here (no key changed): only a retry clears it
    expect(screen.getByText("Something went wrong showing this content.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByText("fixed now")).toBeInTheDocument()
  })
})
