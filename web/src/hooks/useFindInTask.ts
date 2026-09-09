import { useEffect, useRef, useState, type RefObject } from "react"

import { clearMatches, findRanges, matchPosition, paintMatches, revealMatch } from "@/lib/find"
import type { UiIntents } from "@/lib/ui-intents"

/** A live turn appends constantly; recount on a settled tree, not on every frame. */
const RECOUNT_DEBOUNCE_MS = 120

export interface FindState {
  open: boolean
  query: string
  count: number
  /** `3/17`, or "" when there is nothing to count yet */
  position: string
  /** turns whose activity timeline is not on screen, so not in the haystack */
  collapsed: number
  /** bumped every time the box should take focus — the bar owns its own input */
  focusToken: number
  /**
   * The turn a cross-project result matched in. The conversation opens that
   * turn's activity, because a prose match is inside a timeline nobody has
   * expanded yet — and the count would otherwise read 0/0 for text the daemon
   * just said was there.
   */
  revealTurn: number | null
  setQuery: (query: string) => void
  step: (delta: number) => void
  close: () => void
}

interface Matches {
  ranges: Range[]
  collapsed: number
}

const NOTHING: Matches = { ranges: [], collapsed: 0 }

/** The one DOM read. Module scope, so no caller holds it across a render. */
function scan(root: HTMLElement | null, text: string): Matches {
  if (!root || text === "") return NOTHING
  return {
    ranges: findRanges(root, text),
    collapsed: root.querySelectorAll('[data-activity="collapsed"]').length,
  }
}

/**
 * Find-in-task over the RENDERED transcript (lib/find.ts explains why the DOM
 * is the haystack, and why nothing here mutates it).
 *
 * Counting is driven by EVENTS, never by render: a keystroke recounts in its
 * own handler, and everything the transcript does to itself — a live turn
 * appending, an activity timeline opening, a switched task's turns arriving —
 * arrives as one debounced MutationObserver callback. Deriving from the DOM
 * during render would be a lie the moment React reused the result.
 *
 * Opening is an INTENT, not a prop: ⌘F, the task overflow menu and a picked
 * cross-project result all mean "show me this now", so each one focuses the
 * box, selects what is in it, and jumps to the first match.
 */
export function useFindInTask(scroller: RefObject<HTMLElement | null>, intents: UiIntents): FindState {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Matches>(NOTHING)
  const [current, setCurrent] = useState(0)
  const [focusToken, setFocusToken] = useState(0)
  const [revealTurn, setRevealTurn] = useState<number | null>(null)
  const pendingJump = useRef(false)
  const answered = useRef(intents.findRequest()?.seq ?? 0)
  // The intent subscription must see the CURRENT box without re-subscribing on
  // every keystroke; effects run before any event can fire, so this is exact.
  const asked = useRef(query)
  useEffect(() => {
    asked.current = query
  }, [query])

  useEffect(() => {
    return intents.subscribe(() => {
      const request = intents.findRequest()
      if (!request || request.seq === answered.current) return
      answered.current = request.seq
      const next = request.query ?? asked.current
      setOpen(true)
      setQuery(next)
      setCurrent(0)
      setFocusToken((token) => token + 1)
      setRevealTurn(request.turn)
      // A seeded query usually arrives WITH a task switch, whose transcript is
      // still in flight; the observer below answers that one when it lands.
      pendingJump.current = true
      setMatches(scan(scroller.current, next))
    })
  }, [intents, scroller])

  useEffect(() => {
    const root = scroller.current
    if (!open || !root) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setMatches(scan(root, query)), RECOUNT_DEBOUNCE_MS)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [open, query, scroller])

  const index = matches.ranges.length === 0 ? 0 : Math.min(current, matches.ranges.length - 1)

  useEffect(() => {
    if (!open) {
      clearMatches()
      return
    }
    paintMatches(matches.ranges, index)
    if (pendingJump.current && matches.ranges.length > 0) {
      pendingJump.current = false
      revealMatch(matches.ranges[index])
    }
  }, [index, matches, open])

  // Nothing painted may outlive the pane that was showing it.
  useEffect(() => clearMatches, [])

  return {
    open,
    query,
    count: matches.ranges.length,
    position: matchPosition(matches.ranges.length, index),
    collapsed: matches.collapsed,
    focusToken,
    revealTurn,
    setQuery: (next: string) => {
      setQuery(next)
      setCurrent(0)
      // their own query, their own turns: the handed-over one stops applying
      setRevealTurn(null)
      pendingJump.current = true
      setMatches(scan(scroller.current, next))
    },
    step: (delta: number) => {
      const count = matches.ranges.length
      if (count === 0) return
      const next = (index + delta + count) % count
      setCurrent(next)
      revealMatch(matches.ranges[next])
    },
    close: () => {
      setOpen(false)
      setRevealTurn(null)
      clearMatches()
      scroller.current?.focus()
    },
  }
}
