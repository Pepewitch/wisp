import { fireEvent, render, screen } from "@testing-library/react"
import { useRef, useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { useAutosizeTextarea } from "./useAutosizeTextarea"

/** One line per 20 pixels, which is what a real layout engine would report. */
function measureBy(lines: (text: string) => number) {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  )
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return lines(this.value) * 20
    },
  })
  return () => {
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown }).scrollHeight
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original)
  }
}

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

function Box() {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState("")
  useAutosizeTextarea(ref, value)
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  )
}

describe("a composer that grows with its draft", () => {
  it("takes the measured height and gives it back when the draft shrinks", () => {
    restore = measureBy((text) => text.split("\n").length)
    render(<Box />)
    const box = screen.getByRole("textbox")

    expect(box.style.height).toBe("20px")
    fireEvent.change(box, { target: { value: "one\ntwo\nthree" } })
    expect(box.style.height).toBe("60px")
    fireEvent.change(box, { target: { value: "one" } })
    expect(box.style.height).toBe("20px")
  })

  it("leaves the CSS floor in charge where nothing can be measured", () => {
    // A headless DOM reports 0, and an element pinned to `height: 0px` would
    // be a composer with no composer in it.
    render(<Box />)

    expect(screen.getByRole("textbox").style.height).toBe("")
  })
})
