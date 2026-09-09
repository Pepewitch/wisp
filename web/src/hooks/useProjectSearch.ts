import { useState } from "react"

import { useDebouncedValue } from "@/hooks/useDebouncedValue"

import { displaySnippet, searchOrder } from "@/lib/search-sections"
import { useDaemonRuntime } from "@/lib/runtime"
import type { SearchTaskHit } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * The sidebar's search state. It lives above the pane because ⌘⇧F has to open
 * it from anywhere, and because the drawer on touch and the pane on a pointer
 * are two renders of the same one search.
 *
 * `showArchived` is the pane's own footer switch. The hook needs it for one
 * reason: ↑/↓ must walk exactly the rows on screen, and archived rows are on
 * screen only while it is on.
 */
/** One keystroke's grace before the daemon is asked again. */
export const SEARCH_DEBOUNCE_MS = 150

export interface ProjectSearch {
  /**
   * False against a daemon that does not answer `GET /api/search` — Wisp
   * Desktop can hold a remote connection older than this feature. The pane
   * then offers no search control and ⌘⇧F does nothing, rather than opening a
   * box that can only 404.
   */
  available: boolean
  open: boolean
  /** what is in the box */
  query: string
  /**
   * What the DAEMON is asked. It lags the box, and it lives up here rather
   * than inside the results pane on purpose: the pane mounts on the first
   * keystroke, so a debounce owned down there would let the broadest query of
   * the session — one character — through undebounced.
   */
  daemonQuery: string
  focusToken: number
  activeId: string | null
  request: () => void
  close: () => void
  setQuery: (query: string) => void
  setHits: (hits: SearchTaskHit[]) => void
  /** ↓/↑ over what is ON SCREEN — the switch decides whether that includes archived */
  move: (delta: number) => void
  commit: (onSelect: (id: string) => void) => void
}

export function useProjectSearch(showArchived: boolean, available: boolean): ProjectSearch {
  const runtime = useDaemonRuntime()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [focusToken, setFocusToken] = useState(0)
  const [hits, setHits] = useState<SearchTaskHit[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const daemonQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS)

  return {
    available,
    open: open && available,
    query,
    daemonQuery,
    focusToken,
    activeId,
    request: () => {
      setOpen(true)
      setFocusToken((token) => token + 1)
    },
    close: () => {
      setOpen(false)
      setQuery("")
      setActiveId(null)
    },
    setQuery: (next: string) => {
      setQuery(next)
      setActiveId(null)
    },
    setHits,
    move: (delta: number) => {
      const order = searchOrder(hits, showArchived)
      if (order.length === 0) return
      const at = activeId === null ? -1 : order.indexOf(activeId)
      const next = at === -1 ? (delta > 0 ? 0 : order.length - 1) : (at + delta + order.length) % order.length
      setActiveId(order[next] ?? null)
    },
    commit: (onSelect: (id: string) => void) => {
      const order = searchOrder(hits, showArchived)
      const target = activeId ?? order[0]
      if (target === undefined) return
      onSelect(target)
      // the same hand-over the mouse makes: query AND the turn that matched
      const hit = hits.find((candidate) => candidate.id === target)
      uiIntentsFor(runtime.connectionId).openFind(
        daemonQuery,
        hit === undefined ? null : (displaySnippet(hit)?.turn ?? null)
      )
    },
  }
}
