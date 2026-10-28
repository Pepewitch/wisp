import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"

import type { ProjectMove } from "@/lib/project-order-queue"

/** How far a press travels before it is a drag: under it, a press stays a click. */
export const DRAG_THRESHOLD_PX = 4
/** How long a touch holds still on a header before the row lifts. */
export const LONG_PRESS_MS = 400
/**
 * How far a held touch may drift and still lift. Past it the touch is a
 * scroll, a tap or a drawer's swipe, and it never lifts. Under the phone
 * drawer's own claim (DRAG_CLAIM_PX, 10px), so a swipe is always given up here
 * before the drawer takes it.
 */
export const LONG_PRESS_SLOP_PX = 8

/** The project headers a drag can drop between, in list order. */
const HEADER_SELECTOR = "[data-project-header][data-orderable]"
/** ProjectSection's `mt-2` between two projects */
const SECTION_GAP_PX = 8

export interface ProjectDrag {
  /** the project being dragged, once the press has passed the threshold */
  dragging: string | null
  /** where the insertion line sits, in px from the list's top; null while nothing is dragged */
  lineTop: number | null
  /** start watching a press on a project's header row */
  onPointerDown: (path: string, event: ReactPointerEvent) => void
}

interface Press {
  path: string
  pointerId: number
  /** a finger: it lifts the row by holding still, not by moving */
  touch: boolean
  /** where the press went down */
  x: number
  y: number
  /** where the row started to drag: past the threshold, or where the finger held */
  fromX: number
  fromY: number
  /** where the pointer is now */
  lastX: number
  lastY: number
  started: boolean
  /** the dragged row has left where it started; a release before that changes nothing */
  moved: boolean
  /** Escape ended the drag; the release still owes its click */
  cancelled: boolean
  /** the slot the project would drop into: 0 is above the first header, `paths.length` below the last */
  slot: number
}

/**
 * Reordering the configured projects by dragging a header row, with pointer
 * events and no library. A mouse or pen press becomes a drag once it has
 * moved DRAG_THRESHOLD_PX, so a click on the row, its chevron, its gear or its
 * `+` stays a click. A touch becomes one by holding still for LONG_PRESS_MS:
 * one that moves first is a scroll, a tap or a drawer's swipe, and is left
 * alone. A press that did become a drag swallows the click its release would
 * make. Escape, a lost pointer or a lost window cancels, and a lifted row let
 * go where it lifted changes nothing.
 *
 * Slots are measured from the headers on screen at every move, so the
 * dragged project's tasks folding away and the list scrolling are both
 * accounted for.
 */
export function useProjectDrag({
  listRef,
  paths,
  onReorder,
}: {
  listRef: RefObject<HTMLElement | null>
  /** the configured projects, in their order */
  paths: readonly string[]
  /** undefined: no drag at all */
  onReorder?: (path: string, move: ProjectMove) => void
}): ProjectDrag {
  const [dragging, setDragging] = useState<string | null>(null)
  const [lineTop, setLineTop] = useState<number | null>(null)
  const press = useRef<Press | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const latest = useRef({ paths, onReorder })
  useEffect(() => {
    latest.current = { paths, onReorder }
  }, [paths, onReorder])
  /** the touch under way lifted a row; outlives the press, since pointerup comes before touchend */
  const lifted = useRef(false)

  // A lifted row owns its finger. Its touchmoves are defaulted, so the browser
  // never turns them into a scroll (which would cancel the pointer), and kept
  // from the phone drawer's swipe above the list. Its touchend is defaulted
  // too, so the release makes no click. Non-passive, so only while a drag can.
  const canReorder = onReorder !== undefined
  useEffect(() => {
    const list = listRef.current
    if (!list || !canReorder) return
    const start = () => {
      lifted.current = false
    }
    const move = (event: TouchEvent) => {
      if (!lifted.current) return
      if (event.cancelable) event.preventDefault()
      event.stopPropagation()
    }
    const finish = (event: TouchEvent) => {
      if (lifted.current && event.cancelable) event.preventDefault()
    }
    list.addEventListener("touchstart", start, { passive: true })
    list.addEventListener("touchmove", move, { passive: false })
    list.addEventListener("touchend", finish, { passive: false })
    return () => {
      list.removeEventListener("touchstart", start)
      list.removeEventListener("touchmove", move)
      list.removeEventListener("touchend", finish)
    }
  }, [listRef, canReorder])

  const end = useCallback(() => {
    detach.current?.()
    detach.current = null
    press.current = null
    setDragging(null)
    setLineTop(null)
  }, [])
  useEffect(() => end, [end])

  const measure = useCallback(
    (clientY: number) => {
      const list = listRef.current
      const current = press.current
      if (!list || !current) return
      const headers = [...list.querySelectorAll<HTMLElement>(HEADER_SELECTOR)]
      if (headers.length === 0) return
      const index = headers.findIndex((header) => {
        const rect = header.getBoundingClientRect()
        return clientY < rect.top + rect.height / 2
      })
      const slot = index < 0 ? headers.length : index
      current.slot = slot
      const top = list.getBoundingClientRect().top
      // the line sits in the middle of the gap above a header, or under the
      // last project's section; never above the list, where it would be clipped
      const edge =
        slot < headers.length
          ? headers[slot]!.getBoundingClientRect().top - SECTION_GAP_PX / 2
          : (headers[slot - 1]!.closest("section") ?? headers[slot - 1]!).getBoundingClientRect().bottom + SECTION_GAP_PX / 2
      setLineTop(Math.max(1, Math.round(edge - top)))
    },
    [listRef]
  )

  /** The press is a drag now: lift its row. */
  const lift = useCallback(
    (current: Press) => {
      current.started = true
      // a mouse lifts by moving; a finger lifts standing still, and has yet to move
      current.moved = !current.touch
      current.fromX = current.lastX
      current.fromY = current.lastY
      document.body.dataset.projectDrag = ""
      window.getSelection()?.removeAllRanges()
      setDragging(current.path)
      if (current.touch) {
        lifted.current = true
        if ("vibrate" in navigator) navigator.vibrate(10)
        measure(current.lastY)
      }
    },
    [measure]
  )

  const onPointerDown = useCallback(
    (path: string, event: ReactPointerEvent) => {
      if (!latest.current.onReorder || event.button !== 0) return
      if (!latest.current.paths.includes(path)) return
      end()
      const from = latest.current.paths.indexOf(path)
      const { clientX: x, clientY: y } = event
      const touch = event.pointerType === "touch"
      press.current = {
        path, pointerId: event.pointerId, touch, x, y, fromX: x, fromY: y, lastX: x, lastY: y,
        started: false, moved: false, cancelled: false, slot: from,
      }
      const hold = touch
        ? window.setTimeout(() => {
            if (press.current && !press.current.started) lift(press.current)
          }, LONG_PRESS_MS)
        : undefined

      const onMove = (e: PointerEvent) => {
        const current = press.current
        if (!current || e.pointerId !== current.pointerId || current.cancelled) return
        current.lastX = e.clientX
        current.lastY = e.clientY
        if (!current.started) {
          const travel = Math.hypot(e.clientX - current.x, e.clientY - current.y)
          // a finger that moves before the hold is up is the page's, not a drag
          if (current.touch) return travel > LONG_PRESS_SLOP_PX ? end() : undefined
          if (travel < DRAG_THRESHOLD_PX) return
          lift(current)
        }
        current.moved ||= Math.hypot(e.clientX - current.fromX, e.clientY - current.fromY) >= DRAG_THRESHOLD_PX
        measure(e.clientY)
      }
      const onUp = (e: PointerEvent) => {
        const current = press.current
        if (!current || e.pointerId !== current.pointerId) return
        if (current.started) {
          swallowNextClick()
          const at = latest.current.paths.indexOf(current.path)
          const to = current.slot > at ? current.slot - 1 : current.slot
          if (!current.cancelled && current.moved && at >= 0 && to !== at) latest.current.onReorder?.(current.path, { to })
        }
        end()
      }
      // Android's long press opens a context menu over the lifted row
      const onContextMenu = (e: Event) => {
        if (press.current?.touch) e.preventDefault()
      }
      const onKey = (e: KeyboardEvent) => {
        const current = press.current
        if (e.key !== "Escape" || !current?.started || current.cancelled) return
        e.preventDefault()
        e.stopPropagation()
        current.cancelled = true
        delete document.body.dataset.projectDrag
        setDragging(null)
        setLineTop(null)
      }
      const cancel = () => end()
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", cancel)
      window.addEventListener("blur", cancel)
      window.addEventListener("keydown", onKey, true)
      window.addEventListener("contextmenu", onContextMenu, true)
      detach.current = () => {
        window.clearTimeout(hold)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", cancel)
        window.removeEventListener("blur", cancel)
        window.removeEventListener("keydown", onKey, true)
        window.removeEventListener("contextmenu", onContextMenu, true)
        delete document.body.dataset.projectDrag
      }
    },
    [end, lift, measure]
  )

  return { dragging, lineTop, onPointerDown }
}

/**
 * The release that ends a drag still clicks whatever it lands on — most often
 * the row's own chevron, which would fold the project. Swallow that one click,
 * and only it: the listener goes once the release's own task has run.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener("click", swallow, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0)
}
