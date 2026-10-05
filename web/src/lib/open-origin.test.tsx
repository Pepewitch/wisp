import { fireEvent, render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { HoldWhileClosing, useOpenOrigin } from "./open-origin"

describe("useOpenOrigin", () => {
  it("takes the press that opened the popup and keeps it through the close", () => {
    const { result, rerender } = renderHook(({ open }) => useOpenOrigin(open), { initialProps: { open: false } })
    expect(result.current).toBeUndefined()

    fireEvent.pointerDown(document.body, { clientX: 120, clientY: 340 })
    rerender({ open: true })
    expect(result.current).toEqual({ "--open-x": "120px", "--open-y": "340px" })

    // a press while open (the backdrop, to close it) must not move the origin
    fireEvent.pointerDown(document.body, { clientX: 5, clientY: 5 })
    rerender({ open: false })
    expect(result.current).toEqual({ "--open-x": "120px", "--open-y": "340px" })
  })
})

describe("HoldWhileClosing", () => {
  it("keeps the last content on screen while the popup closes", () => {
    const { rerender } = render(<HoldWhileClosing closing={false}>plan.md</HoldWhileClosing>)
    rerender(<HoldWhileClosing closing>{null}</HoldWhileClosing>)
    expect(screen.getByText("plan.md")).toBeTruthy()
    rerender(<HoldWhileClosing closing={false}>notes.md</HoldWhileClosing>)
    expect(screen.getByText("notes.md")).toBeTruthy()
  })
})
