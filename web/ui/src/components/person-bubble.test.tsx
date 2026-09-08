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

describe("the person bubble's floating actions", () => {
  const toolbar = (): HTMLElement => screen.getByText("copy").parentElement!

  it("floats them clear above the card, where they cannot land on the words", () => {
    render(<PersonBubble actions={<span>copy</span>}>said something</PersonBubble>)

    // ON the card, so the card is the hover group; ABOVE it, so a toolbar that
    // grows a third control never sits on a one-line bubble's text
    expect(bubble().contains(toolbar())).toBe(true)
    expect(toolbar().className).toContain("absolute")
    expect(toolbar().className).toContain("bottom-full")
  })

  it("hides them only where a pointer can bring them back", () => {
    render(<PersonBubble actions={<span>copy</span>}>said something</PersonBubble>)

    // §6b: nothing is revealed by hover on touch. Tailwind's own `hover:` is
    // already `@media (hover: hover)`, so an unguarded `opacity-0` would make
    // these unreachable there forever — every hidden state is `pointer:`-gated.
    const classes = toolbar().className.split(/\s+/)
    expect(classes).toContain("pointer:opacity-0")
    expect(classes).toContain("pointer:group-hover/bubble:opacity-100")
    expect(classes).not.toContain("opacity-0")
  })

  it("keeps a keyboard able to reach them", () => {
    render(<PersonBubble actions={<span>copy</span>}>said something</PersonBubble>)

    expect(toolbar().className).toContain("pointer:group-focus-within/bubble:opacity-100")
  })

  it("renders no toolbar when a bubble has no controls", () => {
    render(<PersonBubble caption={<span>5 min ago</span>}>said something</PersonBubble>)

    expect(bubble().querySelector(".absolute")).toBeNull()
  })
})
