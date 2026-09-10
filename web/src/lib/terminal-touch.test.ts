import { describe, expect, it } from "vitest"

import { cellHeightOf, TouchScrollGesture, TOUCH_SCROLL_THRESHOLD_PX } from "./terminal-touch"

/** One row, in the pane's real neighbourhood: 11.5px at 1.45 line height. */
const CELL = 17

/** Drag a finger from `from` to `to` in `steps`, collecting what each move asks for. */
function swipe(gesture: TouchScrollGesture, from: number, to: number, steps: number) {
  gesture.start(from)
  const moves = []
  for (let i = 1; i <= steps; i++) {
    moves.push(gesture.move(from + ((to - from) * i) / steps, CELL))
  }
  return {
    lines: moves.reduce((total, move) => total + move.lines, 0),
    claimed: moves.some((move) => move.claimed),
    moves,
  }
}

describe("TouchScrollGesture", () => {
  it("leaves a tap alone, so the touch still reaches xterm as focus", () => {
    // The whole point of the threshold: below it nothing is claimed, the caller
    // does not default the event, and the browser still synthesizes the mouse
    // events that focus the terminal and raise the keyboard.
    const result = swipe(new TouchScrollGesture(), 200, 200 - (TOUCH_SCROLL_THRESHOLD_PX - 1), 4)

    expect(result.claimed).toBe(false)
    expect(result.lines).toBe(0)
  })

  it("claims the gesture once the finger passes the threshold", () => {
    const result = swipe(new TouchScrollGesture(), 200, 100, 5)

    expect(result.claimed).toBe(true)
  })

  it("scrolls back into scrollback when the finger drags down", () => {
    // Finger down the screen means "show me what came before" — negative, in
    // xterm's direction, the same sign its wheel handler uses.
    const result = swipe(new TouchScrollGesture(), 100, 100 + CELL * 6, 6)

    expect(result.lines).toBeLessThan(0)
    expect(result.lines).toBe(-6)
  })

  it("scrolls toward the newest output when the finger drags up", () => {
    const result = swipe(new TouchScrollGesture(), 300, 300 - CELL * 4, 4)

    expect(result.lines).toBe(4)
  })

  it("counts the distance it took to cross the threshold", () => {
    // A flick is one or two moves, and the first of them is what qualified the
    // gesture. Discarding that distance would drop most of a fast swipe.
    const gesture = new TouchScrollGesture()
    gesture.start(400)
    const step = gesture.move(400 - CELL * 5, CELL)

    expect(step.claimed).toBe(true)
    expect(step.lines).toBe(5)
  })

  it("banks sub-row pixels instead of truncating them away", () => {
    // A slow drag moves a few pixels per frame. Truncating each move
    // independently would round every one of them to zero and the terminal
    // would sit still under a finger that is plainly moving.
    const gesture = new TouchScrollGesture(0)
    gesture.start(500)
    let position = 500
    let total = 0
    for (let i = 0; i < CELL; i++) {
      position -= 1
      total += gesture.move(position, CELL).lines
    }

    expect(total).toBe(1)
  })

  it("does not scroll a terminal that has not been measured", () => {
    // An inactive tab is hidden, so its rows have no height. Banking pixels
    // against a cell height of 0 would spend them at the wrong scale later.
    const gesture = new TouchScrollGesture()
    gesture.start(200)

    expect(gesture.move(100, 0)).toEqual({ lines: 0, claimed: false })
    // Those 100 unmeasurable pixels are gone rather than banked, so the first
    // measured move spends only its own 50.
    expect(gesture.move(50, CELL).lines).toBe(Math.trunc(50 / CELL))
  })

  it("abandons a previous gesture's progress on the next touch", () => {
    const gesture = new TouchScrollGesture()
    swipe(gesture, 300, 300 - CELL * 3 - 5, 3)
    gesture.start(300)

    expect(gesture.claimed).toBe(false)
    // The 5 banked pixels from the last swipe must not tip this one early.
    expect(gesture.move(300 - (TOUCH_SCROLL_THRESHOLD_PX - 1), CELL).lines).toBe(0)
  })
})

describe("cellHeightOf", () => {
  it("divides the rendered screen by its rows", () => {
    const screen = document.createElement("div")
    screen.getBoundingClientRect = () => ({ height: 340 }) as DOMRect

    expect(cellHeightOf(screen, 20)).toBe(17)
  })

  it("answers 0 rather than Infinity or NaN when there is nothing to measure", () => {
    const screen = document.createElement("div")
    screen.getBoundingClientRect = () => ({ height: 0 }) as DOMRect

    expect(cellHeightOf(null, 20)).toBe(0)
    expect(cellHeightOf(screen, 20)).toBe(0)
    expect(cellHeightOf(screen, 0)).toBe(0)
  })
})
