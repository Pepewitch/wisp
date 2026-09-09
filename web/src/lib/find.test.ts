import { beforeEach, describe, expect, it } from "vitest"

import { canPaintMatches, findRanges, matchPosition, snippetParts } from "./find"

/**
 * The haystack is the DOM on purpose (see lib/find.ts), so these tests build
 * one. jsdom has no CSS Custom Highlight API, which is exactly the runtime the
 * bar has to survive: counting and walking work, painting is skipped.
 */
function transcript(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.append(root)
  return root
}

beforeEach(() => {
  document.body.innerHTML = ""
})

describe("findRanges", () => {
  it("counts every occurrence, case-insensitively", () => {
    const root = transcript("<p>Reducer, reducer, REDUCER</p>")
    expect(findRanges(root, "reducer")).toHaveLength(3)
  })

  it("finds text split across elements, because prose is", () => {
    const root = transcript("<p>the <em>steer</em> box</p>")
    const ranges = findRanges(root, "steer box")

    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.toString()).toBe("steer box")
  })

  it("does not overlap matches, so the counter agrees with pressing Enter", () => {
    const root = transcript("<p>aaaa</p>")
    expect(findRanges(root, "aa")).toHaveLength(2)
  })

  it("answers nothing for an empty needle rather than every position", () => {
    const root = transcript("<p>anything</p>")
    expect(findRanges(root, "")).toEqual([])
  })

  it("reads the whole subtree in document order", () => {
    const root = transcript(
      '<article data-turn="1"><div>needle one</div><div>needle two</div></article>',
    )
    const ranges = findRanges(root, "needle")

    expect(ranges).toHaveLength(2)
    expect(ranges[0]!.startContainer.nodeValue).toBe("needle one")
    expect(ranges[1]!.startContainer.nodeValue).toBe("needle two")
  })
})

describe("the counter", () => {
  it("is one-based for people and empty when there is nothing to count", () => {
    expect(matchPosition(17, 2)).toBe("3/17")
    expect(matchPosition(0, 0)).toBe("")
  })
})

describe("canPaintMatches", () => {
  it("is false where ::highlight() does not exist, without throwing", () => {
    expect(canPaintMatches()).toBe(false)
  })
})

describe("snippetParts", () => {
  it("splits on the position the daemon reported", () => {
    expect(snippetParts("…and the needle here", 9, 6)).toEqual({
      before: "…and the ",
      match: "needle",
      after: " here",
    })
  })

  it("clamps a position past the end instead of producing junk", () => {
    expect(snippetParts("short", 99, 6)).toEqual({ before: "short", match: "", after: "" })
  })

  it("trims a long lead so the match survives a 260px row", () => {
    const text = "…the composer should vacuum its draft before the turn"
    const parts = snippetParts(text, text.indexOf("vacuum"), 6)

    expect(parts.before.length).toBeLessThanOrEqual(15)
    expect(parts.before.startsWith("…")).toBe(true)
    // cut on a word boundary, never mid-word
    expect(parts.before).toBe("…should ")
    expect(parts.match).toBe("vacuum")
  })

  it("keeps a short lead exactly as the daemon sent it", () => {
    expect(snippetParts("wrote vacuum", 6, 6).before).toBe("wrote ")
  })
})
