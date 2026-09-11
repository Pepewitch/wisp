/**
 * Swipe-to-scroll for the terminal pane, and the geometry it needs.
 *
 * xterm 5.x scrolled its own viewport on touch — `Viewport.handleTouchStart`
 * and `handleTouchMove`, wired from the terminal element with a guard for
 * programs that have mouse reporting on. xterm 6 replaced the viewport
 * wholesale with a scroll bar vendored from VS Code (a declared breaking
 * change) and those handlers did not come across. What is left reads exactly
 * two things: wheel events, and pointer drags on a 14px scroll bar — a third
 * of this app's own floor for a touch target.
 *
 * Nothing catches the gesture below that, either. The DOM renderer builds row
 * elements only for the VISIBLE rows and sizes the screen to them, so no
 * element overflows and there is no native scroller for a finger to drag; the
 * 5.x line kept a spacer stretched to the whole buffer for that reason and
 * dropped it in the same rewrite. So a swipe over a phone's terminal reaches
 * nothing at all, while a thousand lines of scrollback sit in the buffer
 * unreachable.
 *
 * This is that scroll put back, one level up, against the public API.
 *
 * The math lives here rather than in the component for one reason: the
 * tap-versus-swipe boundary decides whether a touch still reaches xterm as the
 * mouse event that focuses it, and focus is what raises the keyboard. Get that
 * wrong and typing — the one thing that already worked on a phone — stops. So
 * it is a pure function of numbers, and it is the part that gets a test.
 */

/**
 * How far a finger travels before the gesture becomes a scroll rather than a
 * tap. Below this the touch is left entirely alone, so the browser still
 * synthesizes the mouse events xterm focuses on.
 *
 * Set at the platform's own press slop rather than lower. A long press is how
 * a finger selects text here (see lib/terminal-clipboard.ts), and iOS gives a
 * press about ten pixels of wobble before it gives up and calls the gesture a
 * pan. Claiming at eight would take the touch away inside that window and
 * cancel presses the platform was still willing to honour.
 */
export const TOUCH_SCROLL_THRESHOLD_PX = 10

/** What one touchmove should do. */
export interface TouchScrollStep {
  /**
   * Rows to scroll, in xterm's sense: positive moves toward the newest output,
   * negative moves back into scrollback. Zero when the gesture has not been
   * claimed yet, or has not yet added up to a whole row.
   */
  lines: number
  /**
   * True once this gesture is a scroll. The caller owns the touch from here —
   * it should default the event so the browser neither pans nor turns the
   * gesture into a click.
   */
  claimed: boolean
}

/**
 * One finger's progress through one swipe.
 *
 * Deliberately not a component: it holds three numbers and answers "how many
 * rows, and is this mine yet". Sub-row movement is BANKED rather than
 * discarded, which is what makes a slow drag scroll at all — a 19px row and a
 * finger moving 4px per frame would otherwise truncate to zero forever and the
 * terminal would sit still under an obviously moving thumb.
 */
export class TouchScrollGesture {
  /** Where the finger went down; the threshold is measured from here. */
  private origin = 0
  /** Where it was on the previous move, so each step is a delta. */
  private previous = 0
  /** Sub-row pixels not yet spent on a whole row. */
  private banked = 0
  private claimedGesture = false
  /**
   * Which finger this gesture is following, or null between gestures.
   *
   * Load-bearing, not bookkeeping. A pinch is two fingers and only one of them
   * is ever tracked; when the OTHER one lifts, the survivor's next move would
   * otherwise be diffed against a position the tracked finger held before the
   * pinch began, and the whole pinch's travel would cash out as one enormous
   * scroll in a single frame.
   */
  private pointer: number | null = null
  private readonly threshold: number

  constructor(threshold: number = TOUCH_SCROLL_THRESHOLD_PX) {
    this.threshold = threshold
  }

  /** A finger went down. Any previous gesture is abandoned, banked pixels and all. */
  start(y: number, pointer: number): void {
    this.origin = y
    this.previous = y
    this.banked = 0
    this.claimedGesture = false
    this.pointer = pointer
  }

  /**
   * Stop following whatever finger this was. Every move is ignored until the
   * next `start`, so a gesture can never be resumed with stale coordinates.
   */
  end(): void {
    this.pointer = null
    this.claimedGesture = false
  }

  /** True once this gesture has been claimed as a scroll. */
  get claimed(): boolean {
    return this.claimedGesture
  }

  /**
   * The finger moved to `y`, with rows currently `cellHeight` CSS pixels tall.
   *
   * Cell height is passed per move rather than held, because the pane is
   * resizable and a theme or zoom change re-measures it mid-session; a gesture
   * spanning that should use the geometry in front of the user, not the one it
   * started at.
   */
  move(y: number, cellHeight: number, pointer: number): TouchScrollStep {
    // Not the finger this gesture is following — or no gesture at all. Read
    // nothing from it, least of all a position to diff against later.
    if (this.pointer === null || pointer !== this.pointer) return { lines: 0, claimed: false }
    const travelled = this.previous - y
    this.previous = y
    // An unmeasured terminal (an inactive tab, a pane mid-mount) has no rows to
    // scroll by. Bank nothing: pixels divided by a cell height that does not
    // exist yet would be spent at the wrong scale once one arrived.
    if (!(cellHeight > 0)) return { lines: 0, claimed: this.claimedGesture }
    // Bank from the very first pixel, including the pre-threshold movement, so
    // a fast flick does not silently lose the distance it took to qualify.
    this.banked += travelled
    if (!this.claimedGesture) {
      if (Math.abs(y - this.origin) < this.threshold) return { lines: 0, claimed: false }
      this.claimedGesture = true
    }
    // Truncate toward zero and keep the change, in whichever direction.
    const lines = Math.trunc(this.banked / cellHeight)
    this.banked -= lines * cellHeight
    return { lines, claimed: true }
  }
}

/**
 * The height of one row, in CSS pixels, or 0 while the terminal has no
 * measured geometry.
 *
 * xterm publishes cell metrics to its renderers and to nobody else, so this
 * reads them back off the element the DOM renderer sizes: the screen is set to
 * exactly the rendered canvas, which is `rows × cellHeight`. That is a
 * division rather than a lookup, but it is the same number, and it comes from
 * the same DOM this app already reaches for in CSS.
 */
export function cellHeightOf(screen: Element | null, rows: number): number {
  if (!screen || !(rows > 0)) return 0
  const height = screen.getBoundingClientRect().height
  return height > 0 ? height / rows : 0
}
