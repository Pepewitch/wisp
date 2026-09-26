import { fireEvent, render, screen } from "@testing-library/react"
import type { SearchAddon } from "@xterm/addon-search"
import { describe, expect, it, vi } from "vitest"

import { TerminalFindBar } from "./terminal-find-bar"

function fakeSearch() {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: () => ({ dispose() {} }),
  }
}

const dark = { matchBackground: "#111111", matchOverviewRuler: "#111111", activeMatchColorOverviewRuler: "#222222" }
const light = { matchBackground: "#eeeeee", matchOverviewRuler: "#eeeeee", activeMatchColorOverviewRuler: "#dddddd" }

describe("TerminalFindBar", () => {
  it("repaints the highlights in the new colours when the theme changes", () => {
    const search = fakeSearch()
    const props = { search: search as unknown as SearchAddon, focusToken: 1, apple: true, onClose: () => {} }
    const view = render(<TerminalFindBar {...props} decorations={dark} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "needle" } })
    expect(search.findNext).toHaveBeenLastCalledWith("needle", expect.objectContaining({ decorations: dark }))

    view.rerender(<TerminalFindBar {...props} decorations={light} />)
    expect(search.findNext).toHaveBeenLastCalledWith("needle", expect.objectContaining({ decorations: light }))
  })
})
