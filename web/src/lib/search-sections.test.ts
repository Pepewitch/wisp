import { describe, expect, it } from "vitest"

import { displaySnippet, layoutSearchHits, searchOrder } from "./search-sections"
import type { SearchTaskHit } from "./types"

function hit(over: Partial<SearchTaskHit> & Pick<SearchTaskHit, "id">): SearchTaskHit {
  return {
    title: `task ${over.id}`,
    repo_path: "/repos/wisp",
    updated_at: "2026-09-01T00:00:00Z",
    state: "done",
    archived: false,
    matches: 1,
    snippets: [],
    ...over,
  }
}

const LIVE_A = hit({ id: "a" })
const LIVE_B = hit({ id: "b", repo_path: "/repos/other" })
const LIVE_C = hit({ id: "c", matches: 4 })
const OLD = hit({ id: "z", archived: true, matches: 2 })

describe("layoutSearchHits", () => {
  it("groups live hits by project, in the order their newest hit appears", () => {
    const layout = layoutSearchHits([LIVE_A, LIVE_B, LIVE_C], false)

    expect(layout.sections.map((section) => section.path)).toEqual(["/repos/wisp", "/repos/other"])
    expect(layout.sections[0]!.hits.map((h) => h.id)).toEqual(["a", "c"])
  })

  it("hides archived hits while the switch is off, and counts them", () => {
    const layout = layoutSearchHits([LIVE_A, OLD], false)

    expect(layout.sections).toHaveLength(1)
    expect(layout.hiddenArchived).toBe(1)
    // the summary counts what is ON SCREEN, so a hidden hit is not in it
    expect(layout.shown).toBe(1)
    expect(layout.matches).toBe(1)
  })

  it("puts them in one section under the live ones when it is on", () => {
    const layout = layoutSearchHits([LIVE_A, OLD, LIVE_B], true)

    expect(layout.sections.map((section) => section.kind)).toEqual(["project", "project", "archived"])
    expect(layout.sections.at(-1)!.hits.map((h) => h.id)).toEqual(["z"])
    expect(layout.hiddenArchived).toBe(0)
    expect(layout.shown).toBe(3)
    expect(layout.matches).toBe(4)
  })

  it("adds no empty archived section when nothing is archived", () => {
    expect(layoutSearchHits([LIVE_A], true).sections.map((section) => section.kind)).toEqual(["project"])
  })
})

describe("searchOrder", () => {
  it("is exactly what is on screen, in that order", () => {
    // archived is the LAST section, so ↓ reaches it after every live row
    expect(searchOrder([LIVE_A, OLD, LIVE_B], true)).toEqual(["a", "b", "z"])
    // the archived row cannot be reached while it is not rendered
    expect(searchOrder([LIVE_A, OLD, LIVE_B], false)).toEqual(["a", "b"])
  })
})

describe("displaySnippet", () => {
  const snippet = (kind: SearchTaskHit["snippets"][number]["kind"]) => ({
    kind,
    turn: 1,
    text: kind,
    offset: 0,
    length: 1,
  })

  it("never spends the row's one line repeating the title above it", () => {
    expect(displaySnippet(hit({ id: "a", snippets: [snippet("title"), snippet("result")] }))?.kind).toBe("result")
  })

  it("prefers what was said over how the turn concluded", () => {
    expect(displaySnippet(hit({ id: "a", snippets: [snippet("result"), snippet("prose")] }))?.kind).toBe("prose")
    expect(displaySnippet(hit({ id: "a", snippets: [snippet("prose"), snippet("prompt")] }))?.kind).toBe("prompt")
  })

  it("has nothing to show when the daemon sent nothing", () => {
    expect(displaySnippet(hit({ id: "a", snippets: [] }))).toBeUndefined()
  })

  it("shows a title snippet when it is all there is", () => {
    expect(displaySnippet(hit({ id: "a", snippets: [snippet("title")] }))?.kind).toBe("title")
  })
})
