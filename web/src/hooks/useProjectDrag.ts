import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"

import { moveProject } from "@/lib/projects"

/** How far a press travels before it is a drag: under it, a press stays a click. */
export const DRAG_THRESHOLD_PX = 4

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
  x: number
  y: number
  started: boolean
  /** Escape ended the drag; the release still owes its click */
  cancelled: boolean
  /** the slot the project would drop into: 0 is above the first header, `paths.length` below the last */
  slot: number
}

/**
 * Reordering the configured projects by dragging a header row, with pointer
 * events and no library. A press becomes a drag only once it has moved
 * DRAG_THRESHOLD_PX, so a click on the row, its chevron, its gear or its `+`
 * stays a click; a press that did become a drag swallows the click its release
 * would make. Escape, a lost pointer or a lost window cancels. A touch press
 * never drags: touch reorders from the row's menu.
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
  onReorder?: (paths: string[]) => void
}): ProjectDrag {
  const [dragging, setDragging] = useState<string | null>(null)
  const [lineTop, setLineTop] = useState<number | null>(null)
  const press = useRef<Press | null>(null)
  const detach = useRef<(() => void) | null>(null)
  const latest = useRef({ paths, onReorder })
  useEffect(() => {
    latest.current = { paths, onReorder }
  }, [paths, onReorder])

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

  const onPointerDown = useCallback(
    (path: string, event: ReactPointerEvent) => {
      if (!latest.current.onReorder || event.button !== 0 || event.pointerType === "touch") return
      // the row's menu opens on this press; it is not a handle
      if (event.target instanceof Element && event.target.closest('[aria-haspopup="menu"]')) return
      if (!latest.current.paths.includes(path)) return
      end()
      const from = latest.current.paths.indexOf(path)
      press.current = { path, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false, cancelled: false, slot: from }

      const onMove = (e: PointerEvent) => {
        const current = press.current
        if (!current || e.pointerId !== current.pointerId || current.cancelled) return
        if (!current.started) {
          if (Math.hypot(e.clientX - current.x, e.clientY - current.y) < DRAG_THRESHOLD_PX) return
          current.started = true
          document.body.dataset.projectDrag = ""
          window.getSelection()?.removeAllRanges()
          setDragging(current.path)
        }
        measure(e.clientY)
      }
      const onUp = (e: PointerEvent) => {
        const current = press.current
        if (!current || e.pointerId !== current.pointerId) return
        if (current.started) {
          swallowNextClick()
          const order = latest.current.paths
          const at = order.indexOf(current.path)
          const to = current.slot > at ? current.slot - 1 : current.slot
          if (!current.cancelled && at >= 0 && to !== at) latest.current.onReorder?.(moveProject(order, at, to))
        }
        end()
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
      detach.current = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", cancel)
        window.removeEventListener("blur", cancel)
        window.removeEventListener("keydown", onKey, true)
        delete document.body.dataset.projectDrag
      }
    },
    [end, measure]
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
