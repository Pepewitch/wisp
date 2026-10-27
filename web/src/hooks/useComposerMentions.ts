import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"

import { useProjectEntries, useRepos } from "@/hooks/queries"
import {
  applyMention,
  entryRows,
  MENTION_LIST_ID,
  MENTION_NAV_KEYS,
  MENTION_PICK_KEYS,
  mentionOptionId,
  mentionProjects,
  mentionTokenAt,
  nextMentionIndex,
  parseMention,
  projectRows,
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
  pick: (row: MentionRow) => void
  hover: (index: number) => void
}

/**
 * The composer's `@` list, as state: which `@` word the caret is in, which row
 * is selected, and what a pick writes. It follows the `/` palette's rules —
 * the list is bound to the word under the caret, Escape dismisses that word
 * until the caret leaves it, and only a pick changes the draft.
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
  const [selection, setSelection] = useState({ query: "", index: 0 })
  /** the `@` a dismissal applies to, exactly as `suppressed` does for `/` */
  const suppressed = useRef<number | null>(null)
  // a draft replaced from outside (a send, a task switch) never re-tracks
  const live = token && value.slice(token.start, token.end) === `@${token.query}` ? token : null

  // asked for on the first `@`, not on every composer mount (the sidebar has usually loaded it)
  const repos = useRepos(token !== null)
  const projects = useMemo(() => mentionProjects(repos.data ?? []), [repos.data])
  const query = live ? parseMention(live.query, projects) : null
  const folder = query?.kind === "entries" ? query : null
  const entries = useProjectEntries(folder?.project.path ?? null, folder?.dir ?? "")

  let rows: MentionRow[] = []
  let status: string | null = null
  if (query?.kind === "projects") rows = projectRows(projects, query.filter)
  else if (folder && entries.data) {
    rows = entryRows(folder, entries.data.project, entries.data.entries)
    if (entries.data.truncated && rows.length > 0) status = "More entries than shown: keep typing to narrow"
  } else if (folder) {
    status = entries.isError ? `Couldn't list ${folder.dir || folder.project.name}: ${entries.error.message}` : "Listing…"
  }
  // an empty list is no list: `@scope/pkg` and an unmatched filter leave Enter to send
  const open = live !== null && (rows.length > 0 || (folder !== null && !entries.data))
  const selected = live && selection.query === live.query ? Math.min(selection.index, rows.length - 1) : 0

  const track = (next: string, at: number | null) => {
    const found = at === null ? null : mentionTokenAt(next, at)
    if (!found) suppressed.current = null
    setToken(found && suppressed.current !== found.start ? found : null)
  }
  const select = (index: number) => setSelection({ query: live?.query ?? "", index })

  const pick = (row: MentionRow) => {
    if (!live) return
    const next = applyMention(value, live, row)
    suppressed.current = null
    // the input event this fires re-tracks through the textarea's onChange
    if (insertUndoable(boxRef.current, live.start, live.end, next.text)) return
    setValue(next.value)
    caretRef.current = next.caret
    track(next.value, next.caret)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !live || event.nativeEvent.isComposing) return false
    if (event.key === "Escape") {
      event.preventDefault()
      suppressed.current = live.start
      setToken(null)
      return true
    }
    if (rows.length === 0 || event.shiftKey || event.altKey) return false
    if (MENTION_NAV_KEYS.has(event.key)) {
      event.preventDefault()
      // from the previous state, so two presses before a render still move twice
      const { key } = event
      setSelection((prev) => {
        const from = prev.query === live.query ? Math.min(prev.index, rows.length - 1) : 0
        return { query: live.query, index: nextMentionIndex(from, key, rows.length) }
      })
      return true
    }
    // ⌘/Ctrl+Enter still sends, list or not
    if (MENTION_PICK_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      pick(rows[selected]!)
      return true
    }
    return false
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
    pick,
    hover: select,
  }
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
