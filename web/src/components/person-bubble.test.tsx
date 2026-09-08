import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BUBBLE_ACTION, PersonBubble, UserMessageCopyButton } from "./person-bubble"

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

  it("lines the toolbar's right edge up with the bubble's own", () => {
    render(<PersonBubble actions={<span>copy</span>}>said something</PersonBubble>)

    // flush, not inset: two edges 8px apart read as a box that missed its corner
    expect(toolbar().className.split(/\s+/)).toContain("-right-px")
  })
})

describe("a control on the floating toolbar", () => {
  const classesOf = (name: string) =>
    screen.getByRole("button", { name }).className.split(/\s+/)

  it("is a square with its glyph in the middle, at both sizes", () => {
    render(
      <PersonBubble actions={<UserMessageCopyButton text="said something" />}>said something</PersonBubble>,
    )

    const classes = classesOf("Copy user message")
    // equal dimensions and one centre, so a 12px glyph cannot sit off-axis in
    // the frame the way a padding-sized button did
    expect(classes).toContain("items-center")
    expect(classes).toContain("justify-center")
    // 32px around a 16px glyph by default, 20px around 12px where a pointer is
    expect(classes).toContain("size-8")
    expect(classes).toContain("[&>svg]:size-4")
    expect(classes).toContain("pointer:size-5")
    expect(classes).toContain("pointer:[&>svg]:size-3")
    expect(classes).not.toContain("p-0.5")
  })

  it("is the same shape whatever the control is", () => {
    render(
      <PersonBubble
        actions={
          <>
            <UserMessageCopyButton text="said something" />
            <button type="button" aria-label="Cancel queued message" className={BUBBLE_ACTION}>
              <span />
            </button>
          </>
        }
      >
        said something
      </PersonBubble>,
    )

    // §6b: the toolbar does not hide on touch, so every control in it is a
    // thumb target there — and one class string is what keeps them equal
    for (const size of ["size-8", "pointer:size-5"]) {
      expect(classesOf("Copy user message")).toContain(size)
      expect(classesOf("Cancel queued message")).toContain(size)
    }
  })
})
