import type { SearchSnippet, SearchTaskHit } from "./types"

/**
 * How a search answer is laid out, in ONE place, because the rendered order
 * and the keyboard's order must be the same order — a ↓ that skips a row you
 * can see, or stops on one you cannot, is worse than no keyboard at all.
 *
 * Live hits come first, grouped by project in the order their newest hit
 * appears (the daemon already sorted newest-first, so a project's position is
 * its most recent match). Archived hits are one section under all of them, and
 * only when the pane's own Show-archived switch is on: with it off they are
 * held back and COUNTED, never quietly dropped.
 */
export interface SearchSection {
  /** the project path, or null for the archived section */
  path: string | null
  kind: "project" | "archived"
  hits: SearchTaskHit[]
}

export interface SearchLayout {
  sections: SearchSection[]
  /** archived matches the switch is currently hiding */
  hiddenArchived: number
  /** tasks actually on screen */
  shown: number
  /** matches actually on screen */
  matches: number
}

export function layoutSearchHits(
  hits: readonly SearchTaskHit[],
  showArchived: boolean
): SearchLayout {
  const projects: SearchSection[] = []
  const byPath = new Map<string, SearchSection>()
  const archived: SearchTaskHit[] = []

  for (const hit of hits) {
    if (hit.archived) {
      archived.push(hit)
      continue
    }
    const section = byPath.get(hit.repo_path)
    if (section) {
      section.hits.push(hit)
      continue
    }
    const created: SearchSection = {
      path: hit.repo_path,
      kind: "project",
      hits: [hit],
    }
    byPath.set(hit.repo_path, created)
    projects.push(created)
  }

  const sections =
    showArchived && archived.length > 0
      ? [...projects, { path: null, kind: "archived" as const, hits: archived }]
      : projects
  const shownHits = sections.flatMap((section) => section.hits)
  return {
    sections,
    hiddenArchived: showArchived ? 0 : archived.length,
    shown: shownHits.length,
    matches: shownHits.reduce((sum, hit) => sum + hit.matches, 0),
  }
}

/**
 * Which of a task's snippets the ROW shows. A 260px row has one line for it,
 * and the daemon may have matched in several places, so the choice is ranked
 * rather than first-come:
 *
 * - `title` is LAST, because the title is already the row's first line — a
 *   snippet repeating it spends the one line saying nothing.
 * - what was SAID ranks above how a turn concluded: `turn.result` is the tail
 *   of the transcript you are about to open anyway, while prose from inside a
 *   turn is exactly the thing you would otherwise have to hunt for.
 */
const SNIPPET_RANK: Record<SearchSnippet["kind"], number> = {
  prompt: 0,
  prose: 1,
  result: 2,
  message: 3,
  title: 4,
}

export function displaySnippet(hit: SearchTaskHit): SearchSnippet | undefined {
  return [...hit.snippets].sort((a, b) => SNIPPET_RANK[a.kind] - SNIPPET_RANK[b.kind])[0]
}

/** The ids the keyboard walks — exactly what is on screen, in that order. */
export function searchOrder(
  hits: readonly SearchTaskHit[],
  showArchived: boolean
): string[] {
  return layoutSearchHits(hits, showArchived).sections.flatMap((section) =>
    section.hits.map((hit) => hit.id)
  )
}
