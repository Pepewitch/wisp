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

describe("parseMention", () => {
  it("is a project filter until the first slash", () => {
    expect(parseMention("", PROJECTS)).toEqual({ kind: "projects", filter: "" })
    expect(parseMention("sup", PROJECTS)).toEqual({ kind: "projects", filter: "sup" })
  })

  it("names a project by its handle, case-insensitively, then splits folder and filter", () => {
    expect(parseMention("superapp/", PROJECTS)).toMatchObject({ kind: "entries", dir: "", filter: "" })
    expect(parseMention("SuperApp/src/co", PROJECTS)).toMatchObject({
      kind: "entries",
      project: PROJECTS[1],
      dir: "src",
      filter: "co",
    })
    expect(parseMention("superapp/src//components/", PROJECTS)).toMatchObject({ dir: "src/components", filter: "" })
    expect(parseMention("My-App/", PROJECTS)).toMatchObject({ project: PROJECTS[2] })
  })

  it("is nothing for a handle no project has, so `@scope/pkg` leaves the composer alone", () => {
    expect(parseMention("types/node", PROJECTS)).toBeNull()
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
  it("lists every project, its path muted, inserting the path", () => {
    const rows = projectRows(PROJECTS, "")
    expect(rows.map((row) => row.label)).toEqual(["wisp", "superapp", "My App", "api-service"])
    expect(rows[1]).toMatchObject({ detail: "/Users/dev/work/superapp", insert: "/Users/dev/work/superapp", keepOpen: false })
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
  const query = (raw: string) => parseMention(raw, PROJECTS) as Extract<MentionQuery, { kind: "entries" }>

  it("offers the folder itself first, then its entries; a folder keeps the list open", () => {
    const rows = entryRows(query("superapp/src/"), "/Users/dev/work/superapp", ENTRIES)
    expect(rows[0]).toMatchObject({ kind: "here", label: "src/", insert: "/Users/dev/work/superapp/src", keepOpen: false })
    expect(rows[1]).toMatchObject({ kind: "dir", label: "components/", insert: "@superapp/src/components/", keepOpen: true })
    expect(rows[3]).toMatchObject({ kind: "file", label: "compose.ts", insert: "/Users/dev/work/superapp/src/compose.ts" })
  })

  it("filters the last segment, prefix first, and drops the folder row once you type", () => {
    const rows = entryRows(query("superapp/src/co"), "/Users/dev/work/superapp", ENTRIES)
    expect(rows.map((row) => row.label)).toEqual(["components/", "config/", "compose.ts"])
    expect(entryRows(query("superapp/src/dex"), "/r", ENTRIES).map((row) => row.label)).toEqual(["index.ts"])
  })

  it("at the root, the folder row is the project", () => {
    const rows = entryRows(query("superapp/"), "/Users/dev/work/superapp", ENTRIES)
    expect(rows[0]).toMatchObject({ label: "superapp/", insert: "/Users/dev/work/superapp" })
    expect(rows[1]).toMatchObject({ insert: "@superapp/components/" })
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

  it("replaces only the token and steps past it with a space", () => {
    const row = projectRows(PROJECTS, "sup")[0]!
    expect(applyMention("see @sup and", token, row)).toEqual({
      text: "/Users/dev/work/superapp ",
      value: "see /Users/dev/work/superapp  and",
      caret: 29,
    })
  })

  it("leaves the caret at the end of a folder so its children list next", () => {
    const row = { key: "dir:src", kind: "dir" as const, label: "src/", insert: "@superapp/src/", keepOpen: true }
    expect(applyMention("see @sup", token, row)).toEqual({ text: "@superapp/src/", value: "see @superapp/src/", caret: 18 })
  })
})

describe("joinPath", () => {
  it("joins with single slashes", () => {
    expect(joinPath("/a/b", "")).toBe("/a/b")
    expect(joinPath("/a/b/", "src", "x.ts")).toBe("/a/b/src/x.ts")
    expect(joinPath("/", "etc")).toBe("/etc")
  })
})
