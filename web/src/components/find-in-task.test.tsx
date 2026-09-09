import { act, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"

import { FindBar, FindBarSpecimen } from "./find-in-task"
import { useFindInTask } from "@/hooks/useFindInTask"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The bar over a stand-in transcript. The real one is the conversation's
 * scroller; what matters here is that the haystack is the rendered DOM and
 * that the bar only ever arrives through an intent (⌘F, the overflow menu, a
 * picked cross-project result).
 */
const CONNECTION = "find-bar-test"
const intents = uiIntentsFor(CONNECTION)

function Harness({ collapsedTurns = 0, touch = false }: { collapsedTurns?: number; touch?: boolean }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const find = useFindInTask(scroller, intents)
  return (
    <div>
      <span data-testid="reveal-turn">{String(find.revealTurn)}</span>
      {find.open && <FindBar state={find} touch={touch} />}
      <div ref={scroller} tabIndex={-1}>
        <article data-turn="1">
          <div data-turn-prompt>please vacuum the reducer</div>
          <div>vacuumed the reducer and the sidebar</div>
          {Array.from({ length: collapsedTurns }, (_, index) => (
            <div key={index} data-activity="collapsed">
              Show activity
            </div>
          ))}
        </article>
      </div>
    </div>
  )
}

const box = () => screen.getByRole("textbox", { name: "Find in task" })
const counter = () => screen.getByRole("search", { name: "Find in task" }).textContent

describe("find in task", () => {
  it("stays out of the way until something asks for it", () => {
    render(<Harness />)

    expect(screen.queryByRole("search", { name: "Find in task" })).toBeNull()
  })

  it("opens on an intent, seeded and counting", () => {
    render(<Harness />)

    act(() => intents.openFind("reducer"))

    expect(box()).toHaveValue("reducer")
    expect(box()).toHaveFocus()
    expect(counter()).toContain("1/2")
  })

  it("recounts as the query is typed, and says zero out loud", () => {
    render(<Harness />)
    act(() => intents.openFind(""))

    fireEvent.change(box(), { target: { value: "sidebar" } })
    expect(counter()).toContain("1/1")

    fireEvent.change(box(), { target: { value: "nothing here" } })
    expect(counter()).toContain("0/0")
  })

  it("walks the matches with Enter, the arrows, and wraps", () => {
    render(<Harness />)
    act(() => intents.openFind("reducer"))

    fireEvent.keyDown(box(), { key: "Enter" })
    expect(counter()).toContain("2/2")

    fireEvent.keyDown(box(), { key: "Enter" })
    expect(counter()).toContain("1/2")

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }))
    expect(counter()).toContain("2/2")

    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true })
    expect(counter()).toContain("1/2")
  })

  it("closes on Escape and on the dismiss control", () => {
    render(<Harness />)
    act(() => intents.openFind("reducer"))

    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByRole("search", { name: "Find in task" })).toBeNull()

    act(() => intents.openFind("reducer"))
    fireEvent.click(screen.getByRole("button", { name: "Close find" }))
    expect(screen.queryByRole("search", { name: "Find in task" })).toBeNull()
  })

  it("admits what it cannot see: a collapsed timeline is not in the haystack", () => {
    render(<Harness collapsedTurns={2} />)
    act(() => intents.openFind("not in the prompt"))

    expect(screen.getByText(/2 turns' activity is still collapsed/)).toBeInTheDocument()
  })

  it("says nothing about collapsed turns while it has matches to show", () => {
    render(<Harness collapsedTurns={2} />)
    act(() => intents.openFind("reducer"))

    expect(screen.queryByText(/still collapsed/)).toBeNull()
  })

  it("carries the turn a cross-project hit matched in, and drops it when you retype", () => {
    render(<Harness />)
    // what a picked `said 3` result issues: the query AND the turn to open
    act(() => intents.openFind("reducer", 3))

    expect(screen.getByTestId("reveal-turn")).toHaveTextContent("3")

    fireEvent.change(box(), { target: { value: "sidebar" } })
    // their own query, their own turns
    expect(screen.getByTestId("reveal-turn")).toHaveTextContent("null")
  })

  it("forgets the handed-over turn when the bar closes", () => {
    render(<Harness />)
    act(() => intents.openFind("reducer", 2))
    fireEvent.keyDown(box(), { key: "Escape" })

    expect(screen.getByTestId("reveal-turn")).toHaveTextContent("null")
  })

  it("takes 44px hit boxes on touch, where 26px is not tappable (§6b)", () => {
    render(<Harness touch />)
    act(() => intents.openFind("reducer"))

    // the shared `lg` control size — the same one the drawer's rows use
    expect(screen.getByRole("button", { name: "Next match" }).className).toContain("size-11")
  })

  it("does not steal focus when the gallery renders it as documentation", () => {
    render(<FindBarSpecimen />)

    expect(document.body).toHaveFocus()
  })

  it("keeps the arrows honest when a webview cannot paint highlights", () => {
    render(<Harness />)
    act(() => intents.openFind("reducer"))

    // jsdom has no CSS Custom Highlight API — the same case as an old webview.
    expect(screen.getByText(/cannot paint highlights/)).toBeInTheDocument()
  })
})
