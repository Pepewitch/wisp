import { describe, expect, it } from "vitest"

import { bufferText, selectionWithin, type BufferLike, type SelectionLike } from "./terminal-clipboard"

/** A buffer of literal rows; `\\` at the end of one marks the next as wrapped. */
function buffer(rows: string[]): BufferLike {
  const lines = rows.map((row, index) => ({
    isWrapped: index > 0 && rows[index - 1]!.endsWith("\\"),
    translateToString: (trimRight?: boolean) => {
      const text = row.replace(/\\$/, "")
      return trimRight ? text.replace(/\s+$/, "") : text
    },
  }))
  return { length: lines.length, getLine: (y: number) => lines[y] }
}

function selection(over: Partial<SelectionLike>): SelectionLike {
  return { isCollapsed: false, anchorNode: null, focusNode: null, toString: () => "", ...over }
}

describe("bufferText", () => {
  it("reads every row, scrollback included", () => {
    expect(bufferText(buffer(["first", "second", "third"]))).toBe("first\nsecond\nthird")
  })

  it("rejoins a soft-wrapped line, because the break belongs to the pane", () => {
    // The terminal broke this at the pane's width. A copy that kept the break
    // would paste a command the shell cannot run.
    expect(bufferText(buffer(["git commit -m \\", "'a long message'"]))).toBe(
      "git commit -m 'a long message'",
    )
  })

  it("drops the blank screen below the prompt but keeps blank lines inside output", () => {
    expect(bufferText(buffer(["output", "", "more", "", "", ""]))).toBe("output\n\nmore")
  })

  it("trims each row's trailing cells rather than copying the padding", () => {
    expect(bufferText(buffer(["text      "]))).toBe("text")
  })

  it("answers empty for a shell that has printed nothing", () => {
    expect(bufferText(buffer(["", "", ""]))).toBe("")
    expect(bufferText(buffer([]))).toBe("")
  })

  it("survives a line the buffer cannot produce", () => {
    const holey: BufferLike = { length: 3, getLine: (y) => (y === 1 ? undefined : buffer(["a"]).getLine(0)) }
    expect(bufferText(holey)).toBe("a\na")
  })
})

describe("selectionWithin", () => {
  const root = document.createElement("div")
  const inside = document.createElement("span")
  const outside = document.createElement("span")
  root.append(inside)

  it("returns the platform's selection when it lies in the terminal", () => {
    // The only selection a finger can make: long press, handles, DOM range —
    // invisible to xterm, which is why copy has to ask for it separately.
    const text = selectionWithin(
      root,
      selection({ anchorNode: inside, focusNode: inside, toString: () => "error: no such file" }),
    )

    expect(text).toBe("error: no such file")
  })

  it("ignores a selection that starts or ends outside the terminal", () => {
    // A selection running from the shell into the conversation beside it is
    // not this pane's to copy.
    const half = { anchorNode: inside, focusNode: outside, toString: () => "spanning" }

    expect(selectionWithin(root, selection(half))).toBe("")
    expect(selectionWithin(root, selection({ ...half, anchorNode: outside, focusNode: inside }))).toBe("")
  })

  it("treats a caret as no selection", () => {
    expect(
      selectionWithin(root, selection({ isCollapsed: true, anchorNode: inside, focusNode: inside })),
    ).toBe("")
  })

  it("answers empty rather than throwing when there is nothing to ask", () => {
    expect(selectionWithin(null, selection({ anchorNode: inside, focusNode: inside }))).toBe("")
    expect(selectionWithin(root, null)).toBe("")
    expect(selectionWithin(root, selection({ anchorNode: null, focusNode: null }))).toBe("")
  })
})
