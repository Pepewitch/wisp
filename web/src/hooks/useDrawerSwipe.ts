import { useEffect, useLayoutEffect, useState, type RefObject } from "react"

import { claimDrag, DragVelocity, settleDuration, settlesOpen, type DragDirection } from "@/lib/drawer-swipe"
import { prefersReducedMotion } from "@/lib/motion"

/** A touch that starts here is typing, selecting or a widget's own pan, never the drawer's. */
const OWN_GESTURE = 'textarea, input, select, [contenteditable]:not([contenteditable="false"]), [role="application"]'
/** An inline popup (the composer's palettes, a menu inside a drawer) keeps its touches too. */
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** The way the drawer leaves the screen: the phone's sidebar slides out left, its task sheet down. */
export type DismissDirection = "left" | "down"

type Axis = "x" | "y"

/** The axis a drawer moves on, and the sign of its way out along that axis. */
const GEOMETRY: Record<DismissDirection, { axis: Axis; out: DragDirection }> = {
  left: { axis: "x", out: -1 },
  down: { axis: "y", out: 1 },
}

interface Drag {
  /** the finger's sign along the axis that this drag wants */
  direction: DragDirection
  opening: boolean
  touch: number
  /** where the touch went down, along the axis and across it */
  along: number
  across: number
  /** how far it has moved along the axis since */
  delta: number
  claimed: boolean
  /** the popup's size along the axis, 0 until a popup is on screen to measure */
  size: number
  velocity: DragVelocity
}

const noop = () => {}

/**
 * A phone drawer, dragged by a thumb from either end: a drag over `surface`
 * the way the drawer comes in opens it, one over the open drawer or its
 * backdrop the way it leaves closes it, and both follow the finger 1:1 and
 * settle by one rule (lib/drawer-swipe.ts). The sidebar moves on x and leaves
 * left; the task sheet moves on y, leaves down and has no surface.
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
  private setOpen: (open: boolean) => void
  private readonly axis: Axis
  private readonly out: DragDirection
  private drag: Drag | null = null
  private frame: number | null = null
  /** the settle under way after a release, and the end it is headed for */
  private settle: { timer: ReturnType<typeof setTimeout>; open: boolean } | null = null
  private popup: HTMLElement | null = null
  private backdrop: HTMLElement | null = null
  private detachPopup = noop
  private detachBackdrop = noop

  constructor(setOpen: (open: boolean) => void, dismiss: DismissDirection) {
    this.setOpen = setOpen
    this.axis = GEOMETRY[dismiss].axis
    this.out = GEOMETRY[dismiss].out
  }

  /** The caller's open state and setter, as of its last commit. */
  sync(open: boolean, setOpen: (open: boolean) => void): void {
    this.setOpen = setOpen
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
    return this.listen(element, true)
  }

  attachPopup = (element: HTMLElement | null): void => {
    this.detachPopup()
    this.detachPopup = element ? this.listen(element, false) : noop
    this.popup = element
    // the popup a drag opened mounts under the finger, not at rest first
    if (element && this.drag?.claimed) this.paint()
  }

  attachBackdrop = (element: HTMLElement | null): void => {
    this.detachBackdrop()
    this.detachBackdrop = element ? this.listen(element, false) : noop
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

  private listen(element: HTMLElement, opening: boolean): () => void {
    const start = (event: TouchEvent) => this.start(event, element, opening)
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

  private start(event: TouchEvent, boundary: HTMLElement, opening: boolean): void {
    // a second finger is a pinch: the drag ends where it is
    if (this.drag?.claimed) return this.release(0)
    this.drag = null
    if (event.touches.length !== 1 || this.settle || pinched()) return
    // opening needs the drawer shut, closing needs it open
    if (opening === this.open) return
    const direction = (opening ? -this.out : this.out) as DragDirection
    const target = event.target instanceof Element ? event.target : null
    if (!target || ownsSwipe(target, boundary, this.axis, direction)) return
    const touch = event.touches[0]!
    const [along, across] = this.split(touch)
    const velocity = new DragVelocity()
    velocity.add(along, event.timeStamp)
    const size = opening ? 0 : this.size()
    this.drag = { direction, opening, touch: touch.identifier, along, across, delta: 0, claimed: false, size, velocity }
  }

  private move(event: TouchEvent): void {
    const drag = this.drag
    const touch = drag && findTouch(event.touches, drag.touch)
    if (!drag || !touch) return
    const [along, across] = this.split(touch)
    const delta = along - drag.along
    drag.velocity.add(along, event.timeStamp)
    if (!drag.claimed) {
      const verdict = claimDrag(delta, across - drag.across, drag.direction)
      if (verdict === "pending") return
      if (verdict === "refuse") {
        this.drag = null
        return
      }
      drag.claimed = true
      if (drag.opening) this.setOpen(true)
    }
    if (event.cancelable) event.preventDefault()
    drag.delta = delta
    this.frame ??= requestAnimationFrame(this.paint)
  }

  private end(event: TouchEvent): void {
    const drag = this.drag
    const touch = drag && findTouch(event.changedTouches, drag.touch)
    if (!drag || !touch) return
    if (drag.claimed) {
      const [along] = this.split(touch)
      drag.delta = along - drag.along
      drag.velocity.add(along, event.timeStamp)
    }
    this.release(drag.velocity.at(event.timeStamp))
  }

  private paint = (): void => {
    this.frame = null
    const drag = this.drag
    if (!drag?.claimed || !this.popup) return
    drag.size ||= this.size()
    if (drag.size) this.write(this.offsetOf(drag), drag.size, 0)
  }

  /** The finger let go at `velocity` (px/ms along the axis): settle to whichever end the rule picks. */
  private release(velocity: number): void {
    const drag = this.drag
    this.drag = null
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (!drag?.claimed) return
    const size = drag.size || this.size()
    const offset = size ? this.offsetOf({ ...drag, size }) : 0
    const towardOpen = -this.out * velocity
    const open = settlesOpen(size ? (size - Math.abs(offset)) / size : 0, towardOpen)
    const target = open ? 0 : this.out * size
    const shown = this.popup !== null && size > 0
    const ms = !shown || prefersReducedMotion()
      ? 0
      : settleDuration(Math.abs(target - offset), size, open ? towardOpen : -towardOpen, tokenMs(open ? "--dur-in" : "--dur-out"))
    if (ms === 0) {
      this.setOpen(open)
      // a closing popup keeps its last transform until base-ui unmounts it:
      // cleared any earlier, it would show at rest, open, for a frame
      if (shown) return open ? this.clear() : this.write(target, size, 0)
      return
    }
    this.write(target, size, ms)
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

  private write(offset: number, size: number, ms: number): void {
    const transition = ms ? `${ms}ms var(--ease-out)` : ""
    if (this.popup) {
      this.popup.style.transition = transition ? `transform ${transition}` : "none"
      this.popup.style.transform = `translate${this.axis.toUpperCase()}(${offset}px)`
    }
    if (this.backdrop) {
      this.backdrop.style.transition = transition ? `opacity ${transition}` : "none"
      this.backdrop.style.opacity = String((size - Math.abs(offset)) / size)
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

  /** The popup's translation along the axis for a drag, clamped between hidden and open. */
  private offsetOf(drag: Drag): number {
    const hidden = this.out * drag.size
    const rest = drag.opening ? hidden : 0
    return Math.min(Math.max(0, hidden), Math.max(Math.min(0, hidden), rest + drag.delta))
  }

  private size(): number {
    if (!this.popup) return 0
    return this.axis === "x" ? this.popup.offsetWidth : this.popup.offsetHeight
  }

  /** A touch's position along the axis, then across it. */
  private split(touch: Touch): [number, number] {
    return this.axis === "x" ? [touch.clientX, touch.clientY] : [touch.clientY, touch.clientX]
  }
}

function findTouch(touches: TouchList, id: number): Touch | null {
  for (let index = 0; index < touches.length; index++) {
    const touch = touches[index]!
    if (touch.identifier === id) return touch
  }
  return null
}

/** A pinched-in page pans under the finger; the drawer leaves that alone. */
function pinched(): boolean {
  const scale = window.visualViewport?.scale
  return scale !== undefined && scale !== 1
}

/**
 * Whether something under the touch owns a drag along `axis` in `direction`:
 * a field, a widget's own pan, an inline popup inside the boundary, or a
 * scroller with content still to reveal that way (a code block or a table
 * sideways, the task sheet's body scrolled down from its top).
 */
function ownsSwipe(target: Element, boundary: HTMLElement, axis: Axis, direction: DragDirection): boolean {
  if (target.closest(OWN_GESTURE)) return true
  // the drawer's own popup is a dialog too; only one inside the boundary counts
  const popup = target.closest(POPUP)
  if (popup && popup !== boundary && boundary.contains(popup)) return true
  for (let element: Element | null = target; element && element !== boundary; element = element.parentElement) {
    const room = axis === "x" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight
    if (room <= 0) continue
    const style = getComputedStyle(element)
    const overflow = axis === "x" ? style.overflowX : style.overflowY
    if (overflow !== "auto" && overflow !== "scroll") continue
    const scrolled = axis === "x" ? element.scrollLeft : element.scrollTop
    // a finger toward +axis scrolls content back toward its start, one toward -axis toward its end
    if (direction === 1 ? scrolled > 0 : scrolled < room - 1) return true
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
 * Wire the drag to a phone drawer that leaves the screen `dismiss`: the
 * returned refs go on the drawer's popup and backdrop, `surface` (when there
 * is one) takes the opening drag, and `request` replaces `setOpen` for every
 * other way in or out.
 */
export function useDrawerSwipe(
  open: boolean,
  setOpen: (open: boolean) => void,
  { dismiss, surface }: { dismiss: DismissDirection; surface?: RefObject<HTMLElement | null> },
) {
  const [swipe] = useState(() => new DrawerSwipe(setOpen, dismiss))
  useLayoutEffect(() => {
    swipe.sync(open, setOpen)
  }, [swipe, open, setOpen])
  useEffect(() => {
    const element = surface?.current
    const detach = element ? swipe.attachSurface(element) : noop
    return () => {
      detach()
      swipe.dispose()
    }
  }, [swipe, surface])
  return { popupRef: swipe.attachPopup, backdropRef: swipe.attachBackdrop, request: swipe.request }
}
