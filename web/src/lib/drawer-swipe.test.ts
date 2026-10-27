import { describe, expect, it } from "vitest"

import { claimDrag, DragVelocity, settleDuration, settlesOpen } from "./drawer-swipe"

describe("claimDrag", () => {
  it("waits out the first 10px, whichever way they go", () => {
    expect(claimDrag(9, 0, 1)).toBe("pending")
    expect(claimDrag(6, 7, 1)).toBe("pending")
  })

  it("claims a sideways drag the right way, and refuses a scroll or the other way", () => {
    expect(claimDrag(12, 2, 1)).toBe("claim")
    expect(claimDrag(15, 10, 1)).toBe("claim")
    expect(claimDrag(14, 10, 1)).toBe("refuse")
    expect(claimDrag(3, 20, 1)).toBe("refuse")
    expect(claimDrag(-12, 0, 1)).toBe("refuse")
    expect(claimDrag(-12, 0, -1)).toBe("claim")
  })
})

describe("settlesOpen", () => {
  it("opens for a rightward fling at any progress", () => {
    expect(settlesOpen(0.05, 0.31)).toBe(true)
    expect(settlesOpen(0.05, 0.29)).toBe(false)
  })

  it("opens past half way unless the finger is moving left", () => {
    expect(settlesOpen(0.51, 0)).toBe(true)
    expect(settlesOpen(0.5, 0)).toBe(false)
    expect(settlesOpen(0.9, -0.1)).toBe(false)
  })
})

describe("settleDuration", () => {
  it("scales the token's duration with what is left of the width", () => {
    expect(settleDuration(300, 300, 0, 180)).toBe(180)
    expect(settleDuration(75, 300, 0, 180)).toBe(45)
    expect(settleDuration(0, 300, 0, 180)).toBe(0)
  })

  it("is shorter for a fling, so the drawer leaves at least as fast as the finger", () => {
    // 200px at 2 px/ms: ease-out's launch is 1/0.22, so ≤ 455ms keeps up; paced is 120
    expect(settleDuration(200, 300, 2, 180)).toBe(120)
    // 200px at 10 px/ms needs ≤ 91ms
    expect(settleDuration(200, 300, 10, 180)).toBe(91)
  })
})

describe("DragVelocity", () => {
  it("reads the end of the drag, and nothing once the finger has stopped", () => {
    const velocity = new DragVelocity()
    velocity.add(0, 0)
    velocity.add(10, 100)
    velocity.add(40, 150)
    velocity.add(80, 200)
    expect(velocity.at(200)).toBeCloseTo(0.7)
    expect(velocity.at(400)).toBe(0)
  })
})
