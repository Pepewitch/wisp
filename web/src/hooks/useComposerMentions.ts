import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"

import { useProjectEntries, useRepos } from "@/hooks/queries"
import {
  applyMention,
  entryRows,
  MENTION_LIST_ID,
  MENTION_NAV_KEYS,
  MENTION_OPEN_KEYS,
  mentionOptionId,
  mentionProjects,
  mentionTokenAt,
  nextMentionIndex,
  parseMention,
  projectRows,
  type MentionNav,
  type MentionQuery,
  type MentionRow,
  type MentionToken,
} from "@/lib/mentions"

export interface ComposerMentions {
  /** the list to float above the composer; null = closed */
  list: { rows: MentionRow[]; selected: number; status: string | null } | null
  /** the textarea's half of the listbox pattern; empty while the list is closed */
  aria: { "aria-autocomplete"?: "list"; "aria-controls"?: string; "aria-activedescendant"?: string }
  /** Recompute the `@` word under the caret; the steer box calls it where it tracks the `/` token. */
  track: (value: string, at: number | null) => void
  /** True when an open list took the key; the textarea then does nothing else with it. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** writes the row's absolute path over the `@` word and closes the list */
  insert: (row: MentionRow) => void
  /** lists a project's or folder's children; a no-op for a file */
  open: (row: MentionRow) => void
  hover: (index: number) => void
}

/**
 * The composer's `@` list, as state: which `@` word the caret is in, which
 * project and folder the picker has open, which row is selected, and what a
 * pick writes. It follows the `/` palette's rules — the list is bound to the
 * word under the caret, Escape dismisses that word until the caret leaves it,
 * and only a pick changes the draft.
 *
 * A pick goes through the browser's own `insertText` where it exists, so ⌘Z
 * takes it back like any typing; a runtime without it gets a plain state
 * write, and loses only that undo step.
 */
export function useComposerMentions({
  boxRef,
  caretRef,
  value,
  setValue,
}: {
  boxRef: RefObject<HTMLTextAreaElement | null>
  caretRef: RefObject<number | null>
  value: string
  setValue: (value: string) => void
}): ComposerMentions {
  const [token, setToken] = useState<MentionToken | null>(null)
  const [selection, setSelection] = useState({ at: "", index: 0 })
  /** the `@` a dismissal applies to, exactly as `suppressed` does for `/` */
  const suppressed = useRef<number | null>(null)
  /**
   * What the picker has open. A ref, not state: a pick's `insertText` fires
   * the textarea's input event synchronously, and that re-track must already
   * see the folder it opened.
   */
  const navRef = useRef<MentionNav | null>(null)
  // a draft replaced from outside (a send, a task switch) never re-tracks
  const live = token && value.slice(token.start, token.end) === `@${token.query}` ? token : null

  // asked for on the first `@`, not on every composer mount (the sidebar has usually loaded it)
  const repos = useRepos(token !== null)
  const projects = useMemo(() => mentionProjects(repos.data ?? []), [repos.data])
  const query = live ? parseMention(live, projects) : null
  const folder = query?.kind === "entries" ? query : null
  const entries = useProjectEntries(folder?.project.path ?? null, folder?.dir ?? "", folder?.filter ?? "")
  const { rows, status } = mentionRows(query, entries)
  // a folder you opened or named always answers, even with nothing in it;
  // a project filter that matches nothing is no list, so `@scope/pkg` sends
  const open = live !== null && (folder !== null || rows.length > 0)
  // what the selection belongs to: the draft's text alone is not enough, `@app/` reads
  // the same before and after one of two `app` projects is opened
  const at = live ? `${live.nav ? `${live.nav.project.path}\0${live.nav.dir}` : ""}\0${live.query}` : ""
  const selected = live && selection.at === at ? Math.min(selection.index, rows.length - 1) : 0

  const track = (next: string, at: number | null) => {
    const found = at === null ? null : mentionTokenAt(next, at, navRef.current)
    const kept = found && suppressed.current !== found.start ? found : null
    if (!found) suppressed.current = null
    navRef.current = kept?.nav ?? null
    setToken(kept)
  }
  const select = (index: number) => setSelection({ at, index })

  const pick = (row: MentionRow, how: "insert" | "open") => {
    if (!live || (how === "open" && !row.open)) return
    const next = applyMention(value, live, row, how)
    suppressed.current = null
    navRef.current = next.nav
    if (!insertUndoable(boxRef.current, live.start, live.end, next.text)) {
      setValue(next.value)
      caretRef.current = next.caret
    }
    // explicitly, not only through onChange: opening one of two `app` projects
    // rewrites `@app/` as `@app/`, and an unchanged value fires no change
    track(next.value, next.caret)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !live || event.nativeEvent.isComposing) return false
    if (event.key === "Escape") {
      event.preventDefault()
      suppressed.current = live.start
      navRef.current = null
      setToken(null)
      return true
    }
    if (event.shiftKey || event.altKey) return false
    if (MENTION_NAV_KEYS.has(event.key) && rows.length > 0) {
      event.preventDefault()
      // from the previous state, so two presses before a render still move twice
      const { key } = event
      setSelection((prev) => {
        const from = prev.at === at ? Math.min(prev.index, rows.length - 1) : 0
        return { at, index: nextMentionIndex(from, key, rows.length) }
      })
      return true
    }
    const row = rows[selected]
    if (event.key === "Enter") {
      // an open list never lets Enter send: not while it loads, not when it is empty
      event.preventDefault()
      if (row && !event.metaKey && !event.ctrlKey) pick(row, "insert")
      return true
    }
    if (!MENTION_OPEN_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return false
    if (event.key === "ArrowRight") {
      // a plain → opens only at the end of the word and with a row to open; anywhere
      // else, and with a modifier (⌘→, ⌥→), it stays a caret shortcut
      const box = event.currentTarget
      if (!row?.open || box.selectionStart !== live.end || box.selectionEnd !== live.end) return false
    }
    event.preventDefault()
    // Tab on a file inserts it, like Enter: there is nothing under it to open
    if (row) pick(row, row.open ? "open" : "insert")
    return true
  }

  return {
    list: open ? { rows, selected, status } : null,
    aria: open
      ? {
          "aria-autocomplete": "list",
          "aria-controls": MENTION_LIST_ID,
          ...(selected >= 0 ? { "aria-activedescendant": mentionOptionId(selected) } : {}),
        }
      : {},
    track,
    onKeyDown,
    insert: (row) => pick(row, "insert"),
    open: (row) => pick(row, "open"),
    hover: select,
  }
}

/** The rows a query offers, and the one muted line that says what the rows cannot. */
function mentionRows(
  query: MentionQuery | null,
  entries: ReturnType<typeof useProjectEntries>
): { rows: MentionRow[]; status: string | null } {
  if (query?.kind === "projects") return { rows: projectRows(query.projects, query.filter), status: null }
  if (!query) return { rows: [], status: null }
  const where = query.dir || query.project.name
  if (!entries.data) {
    return { rows: [], status: entries.isError ? `Couldn't list ${where}: ${entries.error.message}` : "Listing…" }
  }
  const rows = entryRows(query, entries.data.project, entries.data.entries)
  const { incompleteAfter, truncated } = entries.data
  // said before anything else: when the scan stopped, narrowing cannot find the rest
  if (typeof incompleteAfter === "number") {
    return { rows, status: `This folder has more than ${incompleteAfter.toLocaleString("en-US")} entries; not all are searchable` }
  }
  if (rows.length === 0) return { rows, status: `Nothing in ${where} matches “${query.filter}”` }
  return { rows, status: truncated ? `Showing the first ${entries.data.entries.length}: type more to narrow` : null }
}

/**
 * Replace `start..end` of the textarea through `insertText`, which the
 * browser records as one undoable edit. execCommand is deprecated but still
 * the only API that does this; false means the runtime declined it.
 */
function insertUndoable(box: HTMLTextAreaElement | null, start: number, end: number, text: string): boolean {
  if (!box || box.disabled || typeof document.execCommand !== "function") return false
  box.focus()
  box.setSelectionRange(start, end)
  try {
    return document.execCommand("insertText", false, text)
  } catch {
    return false
  }
}
