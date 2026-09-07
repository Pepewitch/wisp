import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { PersonBubble } from "./person-bubble"

/** The card itself: the one element carrying the bubble's fill and radius. */
function bubble(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".bg-card")
  if (!found) throw new Error("no bubble rendered")
  return found
}

describe("the person bubble", () => {
  it("keeps the caption outside the card, so the card holds only the words", () => {
    render(
      <PersonBubble caption={<span>5 min ago</span>}>
        <div>make the legend wrap</div>
      </PersonBubble>,
    )

    const caption = screen.getByText("5 min ago")
    expect(bubble()).toHaveTextContent("make the legend wrap")
    expect(bubble().contains(caption)).toBe(false)
  })

  it("puts the bubble first and reverses the row, so the caption sits in the gutter to its left", () => {
    render(<PersonBubble caption={<span>5 min ago</span>}>said something</PersonBubble>)

    const row = bubble().parentElement!
    // reversed: the bubble is the first child but paints at the right edge, and
    // the caption takes the 24% the bubble's max-width already left empty
    expect(row.className).toContain("flex-row-reverse")
    expect(row.firstElementChild).toBe(bubble())
  })

  it("lets the caption wrap beneath rather than squeezing the words", () => {
    render(<PersonBubble caption={<span>2026-09-06T12:34:56Z</span>}>said something</PersonBubble>)

    // one rule for every width: no breakpoint, no second narrow layout
    expect(bubble().parentElement!.className).toContain("flex-wrap")
    expect(screen.getByText("2026-09-06T12:34:56Z").parentElement!.className).toContain("shrink-0")
  })

  it("renders no caption row at all when there is nothing to put in one", () => {
    render(<PersonBubble>said something</PersonBubble>)

    expect(bubble().parentElement!.children).toHaveLength(1)
  })
})
