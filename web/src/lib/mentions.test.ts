import { describe, expect, it } from "vitest"

import type { RepoInfo } from "@/lib/types"

import {
  applyMention,
  entryRows,
  joinPath,
  mentionHandle,
  mentionProjects,
  mentionTokenAt,
  nextMentionIndex,
  parseMention,
  projectRows,
  quotePath,
  type MentionProject,
  type MentionQuery,
} from "./mentions"

const PROJECTS: MentionProject[] = [
  { name: "wisp", path: "/Users/dev/work/wisp" },
  { name: "superapp", path: "/Users/dev/work/superapp" },
  { name: "My App", path: "/Users/dev/work/my-app" },
  { name: "api-service", path: "/Users/dev/work/api-service" },
]

describe("mentionTokenAt", () => {
  it("opens on an @ at the start of the draft or after whitespace", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(mentionTokenAt("look at @sup", 12)).toEqual({ start: 8, end: 12, query: "sup" })
    expect(mentionTokenAt("x\n@sup/src", 10)).toEqual({ start: 2, end: 10, query: "sup/src" })
  })

  it("never opens on an @ inside a word", () => {
    expect(mentionTokenAt("mail me@host.com", 16)).toBeNull()
    expect(mentionTokenAt("npm@scope", 9)).toBeNull()
    expect(mentionTokenAt("a@", 2)).toBeNull()
  })

  it("is the word under the caret, whole, and nothing when the caret is before the @", () => {
    expect(mentionTokenAt("@superapp/src rest", 4)).toEqual({ start: 0, end: 13, query: "superapp/src" })
    expect(mentionTokenAt("@sup", 0)).toBeNull()
    expect(mentionTokenAt("@sup next", 9)).toBeNull()
  })
})

/** The token a person typing `raw` (caret at its end) would have. */
const typed = (raw: string) => mentionTokenAt(raw, raw.length)!

describe("parseMention", () => {
  it("is a project filter until the first slash", () => {
    expect(parseMention(typed("@"), PROJECTS)).toEqual({ kind: "projects", filter: "", projects: PROJECTS })
    expect(parseMention(typed("@sup"), PROJECTS)).toMatchObject({ kind: "projects", filter: "sup" })
  })

  it("names a project by its handle, case-insensitively, then splits folder and filter", () => {
    expect(parseMention(typed("@superapp/"), PROJECTS)).toMatchObject({ kind: "entries", dir: "", filter: "" })
    expect(parseMention(typed("@SuperApp/src/co"), PROJECTS)).toMatchObject({
      kind: "entries",
      project: PROJECTS[1],
      dir: "src",
      filter: "co",
    })
    expect(parseMention(typed("@superapp/src//components/"), PROJECTS)).toMatchObject({ dir: "src/components", filter: "" })
    expect(parseMention(typed("@My-App/"), PROJECTS)).toMatchObject({ project: PROJECTS[2] })
  })

  it("is nothing for a handle no project has, so `@scope/pkg` leaves the composer alone", () => {
    expect(parseMention(typed("@types/node"), PROJECTS)).toBeNull()
  })

  it("never silently picks the first of several projects a handle names", () => {
    const twins = [
      ...PROJECTS,
      { name: "app", path: "/work/app" },
      { name: "app", path: "/work/other/app" },
      { name: "My-App", path: "/work/my-app-2" },
    ]
    expect(parseMention(typed("@app/src/"), twins)).toEqual({ kind: "projects", filter: "", projects: [twins[4], twins[5]] })
    // normalising `My App` and `My-App` to one handle is a collision too
    expect(parseMention(typed("@my-app/"), twins)).toEqual({ kind: "projects", filter: "", projects: [PROJECTS[2], twins[6]] })
  })

  it("inside what the picker opened, reads the picker's identity, not the draft's handle", () => {
    const twin = { name: "app", path: "/work/other/app" }
    const nav = { start: 4, prefix: "@app/My Docs/", project: twin, dir: "My Docs" }
    const token = mentionTokenAt("see @app/My Docs/gu", 19, nav)!
    expect(token).toMatchObject({ start: 4, end: 19, rest: "gu" })
    expect(parseMention(token, [{ name: "app", path: "/work/app" }, twin])).toEqual({
      kind: "entries",
      project: twin,
      dir: "My Docs",
      filter: "gu",
    })
    expect(parseMention(mentionTokenAt("see @app/My Docs/notes/", 23, nav)!, [])).toMatchObject({ dir: "My Docs/notes", filter: "" })
  })

  it("lets go of the picker once the draft no longer shows what it opened", () => {
    const nav = { start: 0, prefix: "@app/My Docs/", project: PROJECTS[0]!, dir: "My Docs" }
    expect(mentionTokenAt("@app/My Doc", 11, nav)).toBeNull()
    expect(mentionTokenAt("@app/My Docs/x y", 16, nav)).toBeNull()
  })
})

describe("mentionProjects", () => {
  it("offers projects still on disk, an unnamed one by its folder name", () => {
    const repo = (name: string | null, path: string, exists = true) => ({ name, path, exists }) as RepoInfo
    expect(mentionProjects([repo(null, "/w/api-service/"), repo("gone", "/w/gone", false), repo("wisp", "/w/wisp")])).toEqual([
      { name: "api-service", path: "/w/api-service/" },
      { name: "wisp", path: "/w/wisp" },
    ])
  })
})

describe("mentionHandle", () => {
  it("keeps a name typeable as one word and one segment", () => {
    expect(mentionHandle("My App")).toBe("My-App")
    expect(mentionHandle("team/app")).toBe("team-app")
  })
})

describe("projectRows", () => {
  it("lists every project, its path muted, inserting its path or opening it", () => {
    const rows = projectRows(PROJECTS, "")
    expect(rows.map((row) => row.label)).toEqual(["wisp", "superapp", "My App", "api-service"])
    expect(rows[1]).toMatchObject({
      detail: "/Users/dev/work/superapp",
      insert: "/Users/dev/work/superapp",
      open: { project: PROJECTS[1], dir: "" },
    })
    expect(projectRows([{ name: "notes", path: "/Users/dev/My Notes" }], "")[0]!.insert).toBe('"/Users/dev/My Notes"')
  })

  it("ranks a name prefix over a name substring, and never matches on the path", () => {
    expect(projectRows(PROJECTS, "app").map((row) => row.label)).toEqual(["superapp", "My App"])
    expect(projectRows(PROJECTS, "my").map((row) => row.label)).toEqual(["My App"])
    expect(projectRows(PROJECTS, "a").map((row) => row.label)).toEqual(["api-service", "superapp", "My App"])
    expect(projectRows(PROJECTS, "work")).toEqual([])
    expect(projectRows(PROJECTS, "zzz")).toEqual([])
  })
})

describe("entryRows", () => {
  const ENTRIES = [
    { name: "components", kind: "dir" as const },
    { name: "config", kind: "dir" as const },
    { name: "compose.ts", kind: "file" as const },
    { name: "index.ts", kind: "file" as const },
  ]
  const query = (raw: string) => parseMention(typed(raw), PROJECTS) as Extract<MentionQuery, { kind: "entries" }>

  it("every row inserts its absolute path; only a folder can also be opened", () => {
    const rows = entryRows(query("@superapp/src/"), "/Users/dev/work/superapp", ENTRIES)
    expect(rows.map((row) => row.label)).toEqual(["components/", "config/", "compose.ts", "index.ts"])
    expect(rows[0]).toEqual({
      key: "dir:components",
      kind: "dir",
      label: "components/",
      insert: "/Users/dev/work/superapp/src/components",
      open: { project: PROJECTS[1], dir: "src/components" },
    })
    expect(rows[2]).toEqual({ key: "file:compose.ts", kind: "file", label: "compose.ts", insert: "/Users/dev/work/superapp/src/compose.ts" })
  })

  it("filters the last segment, prefix first", () => {
    const rows = entryRows(query("@superapp/src/co"), "/Users/dev/work/superapp", ENTRIES)
    expect(rows.map((row) => row.label)).toEqual(["components/", "config/", "compose.ts"])
    expect(entryRows(query("@superapp/src/dex"), "/r", ENTRIES).map((row) => row.label)).toEqual(["index.ts"])
  })

  it("quotes an inserted path that contains a space", () => {
    const nav = { start: 0, prefix: "@superapp/My Docs/", project: PROJECTS[1]!, dir: "My Docs" }
    const folder = parseMention(mentionTokenAt("@superapp/My Docs/", 18, nav)!, PROJECTS) as Extract<MentionQuery, { kind: "entries" }>
    const rows = entryRows(folder, "/Users/dev/work/superapp", [
      { name: "old notes", kind: "dir" },
      { name: "read me.md", kind: "file" },
    ])
    expect(rows.map((row) => row.insert)).toEqual([
      '"/Users/dev/work/superapp/My Docs/old notes"',
      '"/Users/dev/work/superapp/My Docs/read me.md"',
    ])
  })
})

describe("nextMentionIndex", () => {
  it("wraps ↑/↓ and jumps with Home/End", () => {
    expect(nextMentionIndex(0, "ArrowDown", 3)).toBe(1)
    expect(nextMentionIndex(2, "ArrowDown", 3)).toBe(0)
    expect(nextMentionIndex(0, "ArrowUp", 3)).toBe(2)
    expect(nextMentionIndex(1, "Home", 3)).toBe(0)
    expect(nextMentionIndex(0, "End", 3)).toBe(2)
  })

  it("clamps a stale index and has no selection in an empty list", () => {
    expect(nextMentionIndex(7, "ArrowDown", 3)).toBe(0)
    expect(nextMentionIndex(0, "ArrowDown", 0)).toBe(-1)
  })
})

describe("applyMention", () => {
  const token = { start: 4, end: 8, query: "sup" }
  const [superapp] = projectRows(PROJECTS, "sup")

  it("inserting replaces only the token with the path and steps past it with a space", () => {
    expect(applyMention("see @sup and", token, superapp!, "insert")).toEqual({
      text: "/Users/dev/work/superapp ",
      value: "see /Users/dev/work/superapp  and",
      caret: 29,
      nav: null,
    })
  })

  it("opening a project or folder writes where you are and hands the picker its identity", () => {
    expect(applyMention("see @sup", token, superapp!, "open")).toEqual({
      text: "@superapp/",
      value: "see @superapp/",
      caret: 14,
      nav: { start: 4, prefix: "@superapp/", project: PROJECTS[1], dir: "" },
    })
    const folder = {
      key: "dir:My Docs",
      kind: "dir" as const,
      label: "My Docs/",
      insert: '"/Users/dev/work/superapp/My Docs"',
      open: { project: PROJECTS[1]!, dir: "My Docs" },
    }
    const opened = applyMention("see @superapp/", { start: 4, end: 14, query: "superapp/" }, folder, "open")
    expect(opened).toMatchObject({ value: "see @superapp/My Docs/", caret: 22, nav: { prefix: "@superapp/My Docs/", dir: "My Docs" } })
    // the opened folder survives its own space: the next keystrokes still read it
    expect(mentionTokenAt(opened.value + "re", 24, opened.nav)).toMatchObject({ nav: opened.nav, rest: "re" })
  })
})

describe("quotePath", () => {
  it("quotes only a path with whitespace", () => {
    expect(quotePath("/a/b")).toBe("/a/b")
    expect(quotePath("/a/My Docs")).toBe('"/a/My Docs"')
  })
})

describe("joinPath", () => {
  it("joins with single slashes", () => {
    expect(joinPath("/a/b", "")).toBe("/a/b")
    expect(joinPath("/a/b/", "src", "x.ts")).toBe("/a/b/src/x.ts")
    expect(joinPath("/", "etc")).toBe("/etc")
  })
})
