/**
 * The numbers behind the phone drawer's drag (hooks/useDrawerSwipe.ts): when
 * a touch becomes the drawer's, where a release sends it, and how long the
 * rest of the way takes. Pure, so the feel is pinned by tests rather than by
 * a thumb.
 */

/**
 * Travel before a touch is a drag at all. Below it the touch is still a tap or
 * a press, and the platform's own slop is about the same, so a press is never
 * taken away while the platform would still honour it.
 */
export const DRAG_CLAIM_PX = 10
/** How much more sideways than vertical a drag must be: a scroll that drifts is still a scroll. */
export const DRAG_AXIS_RATIO = 1.5
/** A release faster than this, rightward, opens whatever the progress (px/ms). */
export const FLING_PX_PER_MS = 0.3
/** Slower than this either way is a finger at rest rather than one moving (px/ms). */
const STILL_PX_PER_MS = 0.05
/** The release velocity is read over this much of the drag's end. */
const VELOCITY_WINDOW_MS = 100
/**
 * `--ease-out` is cubic-bezier(0.22, 1, 0.36, 1): it leaves at 1 / 0.22 of its
 * average speed. A settle no longer than distance × this / velocity starts at
 * least as fast as the finger left, so a fling never brakes on release.
 */
const EASE_OUT_LAUNCH = 1 / 0.22

/** +1 is rightward, the way the drawer opens; -1 is leftward, the way it closes. */
export type DragDirection = 1 | -1

/**
 * What a touch that has moved (dx, dy) from where it went down is: still
 * undecided, the drawer's, or something else's (a scroll, the other way) for
 * the rest of its life.
 */
export function claimDrag(dx: number, dy: number, direction: DragDirection): "pending" | "claim" | "refuse" {
  if (Math.hypot(dx, dy) < DRAG_CLAIM_PX) return "pending"
  return Math.sign(dx) === direction && Math.abs(dx) >= DRAG_AXIS_RATIO * Math.abs(dy) ? "claim" : "refuse"
}

/**
 * Where a release sends the drawer, from how open it is (0 to 1) and the
 * finger's rightward velocity. Opening and closing share it, so a drawer
 * dragged from either end settles by the same rule.
 */
export function settlesOpen(progress: number, velocity: number): boolean {
  if (velocity > FLING_PX_PER_MS) return true
  return progress > 0.5 && velocity > -STILL_PX_PER_MS
}

/**
 * How long the rest of the way takes, in ms: the token's duration for the
 * whole width, scaled to what is left, and shortened further for a finger
 * that was already moving toward the end faster than that.
 */
export function settleDuration(distance: number, width: number, velocityTowardEnd: number, fullMs: number): number {
  if (!(distance > 0) || !(width > 0) || !(fullMs > 0)) return 0
  const paced = fullMs * Math.min(1, distance / width)
  if (!(velocityTowardEnd > 0)) return Math.round(paced)
  return Math.round(Math.min(paced, (EASE_OUT_LAUNCH * distance) / velocityTowardEnd))
}

/** The finger's horizontal velocity over the end of a drag, in px/ms. */
export class DragVelocity {
  private samples: { x: number; t: number }[] = []

  add(x: number, t: number): void {
    this.samples.push({ x, t })
    while (this.samples.length > 2 && t - this.samples[0]!.t > VELOCITY_WINDOW_MS) this.samples.shift()
  }

  /** At time `t`: a finger that stopped before lifting has no velocity left. */
  at(t: number): number {
    const recent = this.samples.filter((sample) => t - sample.t <= VELOCITY_WINDOW_MS)
    if (recent.length < 2) return 0
    const first = recent[0]!
    const last = recent[recent.length - 1]!
    const elapsed = last.t - first.t
    return elapsed > 0 ? (last.x - first.x) / elapsed : 0
  }
}
