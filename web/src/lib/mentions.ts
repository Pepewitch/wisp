import type { ProjectEntry } from "../../../shared/api/project-entries"
import type { RepoInfo } from "@/lib/types"

/**
 * The composer's `@` list: Wisp projects, then the files and folders under one.
 *
 * A pick writes an ABSOLUTE path into the draft as plain text — the project's
 * registered checkout, never a task worktree — so the agent in one project's
 * task can be pointed at another project's folder without searching for it.
 *
 *   `@sup`              projects whose name matches `sup`
 *   `@superapp/`        the project's root folder
 *   `@superapp/src/co`  the entries of `src/` matching `co`
 *
 * Only an `@` that starts a word opens it, so an email address never does. A
 * list with nothing to offer is no list at all: `npm i @types/node` (no
 * project called `types`) leaves the composer alone and Enter still sends.
 */

/** The `@…` word under the caret: `start` is the `@`, `query` what follows it. */
export interface MentionToken {
  start: number
  end: number
  query: string
}

/** What the list needs to know about a project, a subset of /api/repos' row. */
export interface MentionProject {
  name: string
  path: string
}

/** The projects the list offers: those still on disk, named as the sidebar names them. */
export function mentionProjects(repos: RepoInfo[]): MentionProject[] {
  return repos
    .filter((repo) => repo.exists)
    .map((repo) => ({ name: repo.name ?? (repo.path.split("/").filter(Boolean).pop() || repo.path), path: repo.path }))
}

export interface MentionRow {
  /** unique within the list, and the option's DOM id suffix */
  key: string
  kind: "project" | "dir" | "file" | "here"
  /** what the row says: a project's name, an entry's name (`src/` for a folder) */
  label: string
  /** the muted second part: a project's path, or what picking "here" inserts */
  detail?: string
  /** the text that replaces the token */
  insert: string
  /** a folder keeps the list open for its children; everything else closes it */
  keepOpen: boolean
}

export function mentionTokenAt(value: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > value.length) return null
  let start = caret
  while (start > 0 && !/\s/.test(value[start - 1]!)) start -= 1
  // the word must START with the `@`: `me@host` is an address, not a mention
  if (start === caret || value[start] !== "@") return null
  let end = caret
  while (end < value.length && !/\s/.test(value[end]!)) end += 1
  return { start, end, query: value.slice(start + 1, end) }
}

/** How a project is typed after `@`: its name, with nothing that would end the word or the segment. */
export function mentionHandle(name: string): string {
  return name.trim().replace(/[\s/]+/g, "-")
}

export type MentionQuery =
  | { kind: "projects"; filter: string }
  | { kind: "entries"; project: MentionProject; dir: string; filter: string }

/**
 * What a token asks for. `@name/…` names a project by its handle (case does
 * not matter); a handle no project has is no query at all, so the list stays
 * shut for `@scope/pkg`.
 */
export function parseMention(query: string, projects: MentionProject[]): MentionQuery | null {
  const slash = query.indexOf("/")
  if (slash === -1) return { kind: "projects", filter: query }
  const handle = query.slice(0, slash).toLowerCase()
  const project = projects.find((candidate) => mentionHandle(candidate.name).toLowerCase() === handle)
  if (!project) return null
  const rest = query.slice(slash + 1)
  const cut = rest.lastIndexOf("/")
  return {
    kind: "entries",
    project,
    dir: cut === -1 ? "" : rest.slice(0, cut).split("/").filter(Boolean).join("/"),
    filter: rest.slice(cut + 1),
  }
}

/**
 * Banded like the `/` palette's ranking: a name that starts with what you
 * typed beats one that merely contains it, and list order breaks ties. `null`
 * means the row does not match.
 */
function matchBand(text: string, filter: string): number | null {
  if (filter === "") return 0
  const haystack = text.toLowerCase()
  const needle = filter.toLowerCase()
  if (haystack.startsWith(needle)) return 0
  if (haystack.includes(needle)) return 1
  return null
}

function ranked<T>(items: T[], band: (item: T) => number | null): T[] {
  return items
    .map((item, index) => ({ item, index, band: band(item) }))
    .filter((entry): entry is { item: T; index: number; band: number } => entry.band !== null)
    .sort((a, b) => a.band - b.band || a.index - b.index)
    .map((entry) => entry.item)
}

export function projectRows(projects: MentionProject[], filter: string): MentionRow[] {
  // the name only: every path shares its first segments, so `@s` would match them all
  return ranked(projects, (project) => matchBand(mentionHandle(project.name), filter)).map((project) => ({
    key: `project:${project.path}`,
    kind: "project",
    label: project.name,
    detail: project.path,
    insert: project.path,
    keepOpen: false,
  }))
}

/** `root` + relative segments, with exactly one `/` between each. */
export function joinPath(root: string, ...parts: string[]): string {
  const tail = parts.flatMap((part) => part.split("/")).filter(Boolean)
  const head = root.length > 1 ? root.replace(/\/+$/, "") : root
  return tail.length === 0 ? head : `${head === "/" ? "" : head}/${tail.join("/")}`
}

/**
 * The rows for one listed folder. Before you filter, the first row is the
 * folder itself, so `@superapp/src/` + Enter inserts that folder's path; a
 * folder row below it opens its children instead.
 */
export function entryRows(
  query: Extract<MentionQuery, { kind: "entries" }>,
  root: string,
  entries: ProjectEntry[],
): MentionRow[] {
  const handle = mentionHandle(query.project.name)
  const prefix = query.dir === "" ? `@${handle}/` : `@${handle}/${query.dir}/`
  const here: MentionRow[] =
    query.filter === ""
      ? [
          {
            key: "here",
            kind: "here",
            label: query.dir === "" ? `${handle}/` : `${query.dir.split("/").pop()}/`,
            detail: joinPath(root, query.dir),
            insert: joinPath(root, query.dir),
            keepOpen: false,
          },
        ]
      : []
  const matches = ranked(entries, (entry) => matchBand(entry.name, query.filter)).map(
    (entry): MentionRow =>
      entry.kind === "dir"
        ? { key: `dir:${entry.name}`, kind: "dir", label: `${entry.name}/`, insert: `${prefix}${entry.name}/`, keepOpen: true }
        : {
            key: `file:${entry.name}`,
            kind: "file",
            label: entry.name,
            insert: joinPath(root, query.dir, entry.name),
            keepOpen: false,
          },
  )
  return [...here, ...matches]
}

/**
 * ↑/↓ wrap like the `/` palette (`loop`); Home/End jump. Anything else leaves
 * the selection where it is, and an empty list has none.
 */
export function nextMentionIndex(current: number, key: string, count: number): number {
  if (count === 0) return -1
  const at = Math.min(Math.max(current, 0), count - 1)
  if (key === "ArrowDown") return (at + 1) % count
  if (key === "ArrowUp") return (at - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return at
}

/** The listbox the composer's textarea points at with aria-controls / aria-activedescendant. */
export const MENTION_LIST_ID = "composer-mention-list"

export function mentionOptionId(index: number): string {
  return `${MENTION_LIST_ID}-${index}`
}

/** The keys the textarea hands to an open `@` list instead of acting on them. */
export const MENTION_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"])
export const MENTION_PICK_KEYS = new Set(["Enter", "Tab"])

/**
 * The draft after a pick, and where the caret goes. A pick that closes the
 * list is followed by a space, so the caret leaves the word and neither list
 * reopens on the inserted path (which starts with a `/`).
 */
export function applyMention(value: string, token: MentionToken, row: MentionRow): { text: string; value: string; caret: number } {
  const text = row.keepOpen ? row.insert : `${row.insert} `
  return { text, value: value.slice(0, token.start) + text + value.slice(token.end), caret: token.start + text.length }
}
