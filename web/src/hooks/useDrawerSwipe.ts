import { useEffect, useLayoutEffect, useState, type RefObject } from "react"

import { claimDrag, DragVelocity, settleDuration, settlesOpen, type DragDirection } from "@/lib/drawer-swipe"
import { prefersReducedMotion } from "@/lib/motion"

/** A touch that starts here is typing, selecting or a widget's own pan, never the drawer's. */
const OWN_GESTURE = 'textarea, input, select, [contenteditable]:not([contenteditable="false"]), [role="application"]'
/** An inline popup over the shell (the composer's palettes) keeps its touches too. */
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

interface Drag {
  direction: DragDirection
  touch: number
  x: number
  y: number
  dx: number
  claimed: boolean
  /** the popup's width, 0 until a popup is on screen to measure */
  width: number
  velocity: DragVelocity
}

const noop = () => {}

/**
 * The phone drawer, dragged by a thumb from either end: a sideways drag over
 * the shell opens it, one over the open drawer or its backdrop closes it, and
 * both follow the finger 1:1 and settle by one rule (lib/drawer-swipe.ts).
 *
 * Not base-ui's `Drawer.SwipeArea`: that is a strip laid over the content,
 * which would take every tap and scroll from the conversation under it, and
 * it hands a touch that starts over a scroller back to the scroller, so a
 * drag over the transcript would never open anything.
 *
 * Touch events, not pointer events: a touchmove can be defaulted once the drag
 * is claimed, which keeps the browser from turning the same finger into a pan
 * and cancelling it, and a mouse drag stays a text selection.
 *
 * The open state stays the caller's. A drag writes the popup's transform and
 * the backdrop's opacity directly, a frame at a time, and leaves them inline
 * until the settle is over; `request` is how everything else opens or closes
 * the drawer, and it is refused while a drag holds it.
 */
class DrawerSwipe {
  private open = false
  private readonly setOpen: (open: boolean) => void
  private drag: Drag | null = null
  private frame: number | null = null
  /** the settle under way after a release, and the end it is headed for */
  private settle: { timer: ReturnType<typeof setTimeout>; open: boolean } | null = null
  private popup: HTMLElement | null = null
  private backdrop: HTMLElement | null = null
  private detachPopup = noop
  private detachBackdrop = noop

  constructor(setOpen: (open: boolean) => void) {
    this.setOpen = setOpen
  }

  /** The caller's open state, as of its last commit. */
  sync(open: boolean): void {
    this.open = open
  }

  request = (open: boolean): void => {
    if (this.drag?.claimed) return
    const settle = this.settle
    if (settle) {
      clearTimeout(settle.timer)
      this.settle = null
      // a drawer already sliding shut keeps sliding when asked to close
      if (settle.open) this.clear()
    }
    // and one asked to open never keeps a transform a drag left it hidden at
    if (open) this.clear()
    this.setOpen(open)
  }

  attachSurface(element: HTMLElement): () => void {
    return this.listen(element, 1)
  }

  attachPopup = (element: HTMLElement | null): void => {
    this.detachPopup()
    this.detachPopup = element ? this.listen(element, -1) : noop
    this.popup = element
    // the popup a drag opened mounts under the finger, not at rest first
    if (element && this.drag?.claimed) this.paint()
  }

  attachBackdrop = (element: HTMLElement | null): void => {
    this.detachBackdrop()
    this.detachBackdrop = element ? this.listen(element, -1) : noop
    this.backdrop = element
    if (element && this.drag?.claimed) this.paint()
  }

  dispose(): void {
    this.drag = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.settle) clearTimeout(this.settle.timer)
    this.settle = null
  }

  private listen(element: HTMLElement, direction: DragDirection): () => void {
    const start = (event: TouchEvent) => this.start(event, element, direction)
    const move = (event: TouchEvent) => this.move(event)
    const end = (event: TouchEvent) => this.end(event)
    const cancel = () => this.release(0)
    element.addEventListener("touchstart", start, { passive: true })
    // the one listener that cannot be passive: a claimed drag defaults its moves
    element.addEventListener("touchmove", move, { passive: false })
    element.addEventListener("touchend", end, { passive: true })
    element.addEventListener("touchcancel", cancel, { passive: true })
    return () => {
      element.removeEventListener("touchstart", start)
      element.removeEventListener("touchmove", move)
      element.removeEventListener("touchend", end)
      element.removeEventListener("touchcancel", cancel)
    }
  }

  private start(event: TouchEvent, boundary: HTMLElement, direction: DragDirection): void {
    // a second finger is a pinch: the drag ends where it is
    if (this.drag?.claimed) return this.release(0)
    this.drag = null
    if (event.touches.length !== 1 || this.settle || pinched()) return
    // opening needs the drawer shut, closing needs it open
    if ((direction === 1) === this.open) return
    const target = event.target instanceof Element ? event.target : null
    if (!target || ownsSwipe(target, boundary, direction)) return
    const touch = event.touches[0]!
    const velocity = new DragVelocity()
    velocity.add(touch.clientX, event.timeStamp)
    const width = direction === -1 ? (this.popup?.offsetWidth ?? 0) : 0
    this.drag = { direction, touch: touch.identifier, x: touch.clientX, y: touch.clientY, dx: 0, claimed: false, width, velocity }
  }

  private move(event: TouchEvent): void {
    const drag = this.drag
    const touch = drag && findTouch(event.touches, drag.touch)
    if (!drag || !touch) return
    const dx = touch.clientX - drag.x
    drag.velocity.add(touch.clientX, event.timeStamp)
    if (!drag.claimed) {
      const verdict = claimDrag(dx, touch.clientY - drag.y, drag.direction)
      if (verdict === "pending") return
      if (verdict === "refuse") {
        this.drag = null
        return
      }
      drag.claimed = true
      if (drag.direction === 1) this.setOpen(true)
    }
    if (event.cancelable) event.preventDefault()
    drag.dx = dx
    this.frame ??= requestAnimationFrame(this.paint)
  }

  private end(event: TouchEvent): void {
    const drag = this.drag
    const touch = drag && findTouch(event.changedTouches, drag.touch)
    if (!drag || !touch) return
    if (drag.claimed) {
      drag.dx = touch.clientX - drag.x
      drag.velocity.add(touch.clientX, event.timeStamp)
    }
    this.release(drag.velocity.at(event.timeStamp))
  }

  private paint = (): void => {
    this.frame = null
    const drag = this.drag
    if (!drag?.claimed || !this.popup) return
    drag.width ||= this.popup.offsetWidth
    if (drag.width) this.write(offsetOf(drag), drag.width, 0)
  }

  /** The finger let go at `velocity` (px/ms, rightward): settle to whichever end the rule picks. */
  private release(velocity: number): void {
    const drag = this.drag
    this.drag = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (!drag?.claimed) return
    const width = drag.width || this.popup?.offsetWidth || 0
    const offset = width ? offsetOf({ ...drag, width }) : 0
    const open = settlesOpen(width ? (width + offset) / width : 0, velocity)
    const target = open ? 0 : -width
    const shown = this.popup !== null && width > 0
    const ms = !shown || prefersReducedMotion()
      ? 0
      : settleDuration(Math.abs(target - offset), width, open ? velocity : -velocity, tokenMs(open ? "--dur-in" : "--dur-out"))
    if (ms === 0) {
      this.setOpen(open)
      // a closing popup keeps its last transform until base-ui unmounts it:
      // cleared any earlier, it would show at rest, open, for a frame
      if (shown) return open ? this.clear() : this.write(target, width, 0)
      return
    }
    this.write(target, width, ms)
    // Closed is committed once the drawer is out of sight. Committed at the
    // release, the close's own render lands in the settle's first frames and
    // holds the drawer still under a finger that has already let go.
    if (open) this.setOpen(true)
    const timer = setTimeout(() => {
      this.settle = null
      if (open) this.clear()
      else this.setOpen(false)
    }, ms)
    this.settle = { timer, open }
  }

  private write(offset: number, width: number, ms: number): void {
    const transition = ms ? `${ms}ms var(--ease-out)` : ""
    if (this.popup) {
      this.popup.style.transition = transition ? `transform ${transition}` : "none"
      this.popup.style.transform = `translateX(${offset}px)`
    }
    if (this.backdrop) {
      this.backdrop.style.transition = transition ? `opacity ${transition}` : "none"
      this.backdrop.style.opacity = String((width + offset) / width)
    }
  }

  /** Hand the popup and backdrop back to the stylesheet. */
  private clear(): void {
    for (const element of [this.popup, this.backdrop]) {
      element?.style.removeProperty("transition")
      element?.style.removeProperty("transform")
      element?.style.removeProperty("opacity")
    }
  }
}

/** The popup's translateX for a drag, clamped between hidden and open. */
function offsetOf(drag: Drag): number {
  const rest = drag.direction === 1 ? -drag.width : 0
  return Math.min(0, Math.max(-drag.width, rest + drag.dx))
}

function findTouch(touches: TouchList, id: number): Touch | null {
  for (let index = 0; index < touches.length; index++) {
    const touch = touches[index]!
    if (touch.identifier === id) return touch
  }
  return null
}

/** A pinched-in page pans sideways under the finger; the drawer leaves that alone. */
function pinched(): boolean {
  const scale = window.visualViewport?.scale
  return scale !== undefined && scale !== 1
}

/**
 * Whether something under the touch owns a sideways drag in `direction`: a
 * field, a widget's own pan, an inline popup, or a scroller with content
 * still to reveal that way (a code block, a table, a wide diagram).
 */
function ownsSwipe(target: Element, boundary: HTMLElement, direction: DragDirection): boolean {
  if (target.closest(OWN_GESTURE)) return true
  if (direction === 1 && target.closest(POPUP)) return true
  for (let element: Element | null = target; element && element !== boundary; element = element.parentElement) {
    const room = element.scrollWidth - element.clientWidth
    if (room <= 0) continue
    const overflow = getComputedStyle(element).overflowX
    if (overflow !== "auto" && overflow !== "scroll") continue
    // a rightward finger scrolls content back toward its start, a leftward one toward its end
    if (direction === 1 ? element.scrollLeft > 0 : element.scrollLeft < room - 1) return true
  }
  return false
}

/** A motion token's duration in ms, from the stylesheet that owns it (index.css). */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const number = Number.parseFloat(value)
  if (!Number.isFinite(number)) return 0
  return value.endsWith("ms") ? number : value.endsWith("s") ? number * 1000 : number
}

/**
 * Wire the drag to the phone shell: `surface` takes the opening drag, the
 * returned refs go on the drawer's popup and backdrop, and `request` replaces
 * `setOpen` for every other way in or out. `setOpen` must be stable (a
 * `useState` setter).
 */
export function useDrawerSwipe(surface: RefObject<HTMLElement | null>, open: boolean, setOpen: (open: boolean) => void) {
  const [swipe] = useState(() => new DrawerSwipe(setOpen))
  useLayoutEffect(() => {
    swipe.sync(open)
  }, [swipe, open])
  useEffect(() => {
    const element = surface.current
    if (!element) return
    const detach = swipe.attachSurface(element)
    return () => {
      detach()
      swipe.dispose()
    }
  }, [swipe, surface])
  return { popupRef: swipe.attachPopup, backdropRef: swipe.attachBackdrop, request: swipe.request }
}
