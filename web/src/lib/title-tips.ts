/**
 * Every `title` in the app, shown as Wisp's own tooltip instead of the browser's.
 *
 * The app names ~110 controls with a plain `title`, and the browser draws those
 * itself: a second's wait, the OS's look, no motion. Rather than wrap each one,
 * this listens once at the document: while a titled element is hovered (or
 * keyboard-focused) its `title` is held aside, so the browser shows nothing, and
 * one shared tip is placed beside it. Leaving gives the `title` back, so
 * everything that reads it (tests, the accessibility tree) sees it unchanged.
 *
 * The first tip waits SHOW_DELAY, so a pointer crossing a toolbar shows nothing.
 * One opened within WARM_FOR of the last one closing appears at once, without
 * the unfold, the way moving along a row of buttons should feel. The look and
 * the motion are CSS (`.wisp-tip` in index.css).
 */

const SHOW_DELAY = 450
const WARM_FOR = 500
const GAP = 6
const EDGE = 8
const OUT_MS = 110

let tip: HTMLDivElement | null = null
let label: HTMLSpanElement | null = null
/** the element whose title is held aside, shown or about to be */
let owner: Element | null = null
let held = ""
let shown = false
let timer = 0
let hideTimer = 0
let warmUntil = 0
let watch: MutationObserver | null = null

export function initTitleTips(): void {
  if (typeof document === "undefined" || tip) return
  // a phone has no hover: its long-press is the OS's business
  if (!window.matchMedia?.("(any-hover: hover)").matches) return
  document.addEventListener("pointerover", onPointerOver, true)
  document.addEventListener("pointerout", onPointerOut, true)
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("focusout", onFocusOut, true)
  document.addEventListener("pointerdown", () => release(), true)
  document.addEventListener("keydown", (event) => event.key === "Escape" && release(), true)
  // only a scroll that moves the owner: the transcript scrolls itself while it streams
  document.addEventListener(
    "scroll",
    (event) => {
      const scroller = event.target
      if (owner && (scroller === document || (scroller instanceof Node && scroller.contains(owner)))) release()
    },
    true
  )
  window.addEventListener("blur", () => release())
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === "touch") return
  const target = event.target as Element | null
  if (owner && !owner.isConnected) release()
  if (owner && target && owner.contains(target)) return
  const next = target?.closest?.("[title]")
  if (next) arm(next)
}

function onPointerOut(event: PointerEvent): void {
  if (!owner) return
  const to = event.relatedTarget as Node | null
  if (to && owner.contains(to)) return
  release()
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target as Element | null
  // only a keyboard focus: a click focuses too, and a tip under the cursor
  // that just pressed the button is noise
  if (!target || !isKeyboardFocus(target)) return
  const next = target.closest("[title]")
  if (next) arm(next)
}

function isKeyboardFocus(el: Element | null): boolean {
  try {
    return !!el?.matches(":focus-visible")
  } catch {
    return false // an engine without :focus-visible: no tips on focus
  }
}

function onFocusOut(): void {
  if (owner && !owner.matches(":hover")) release()
}

function arm(el: Element): void {
  const text = el.getAttribute("title")?.trim()
  if (!text) return
  release(true)
  owner = el
  held = el.getAttribute("title") ?? ""
  el.removeAttribute("title")
  // a control that renames itself while shown ("Copy" → "Copied") updates the tip
  watch = new MutationObserver(() => {
    if (!owner?.hasAttribute("title")) return
    held = owner.getAttribute("title") ?? ""
    owner.removeAttribute("title")
    if (shown && label) label.textContent = held
  })
  watch.observe(el, { attributes: true, attributeFilter: ["title"] })
  const warm = performance.now() < warmUntil
  timer = window.setTimeout(() => show(warm), warm ? 0 : SHOW_DELAY)
}

function ensureTip(): HTMLDivElement {
  if (tip) return tip
  tip = document.createElement("div")
  tip.className = "wisp-tip"
  tip.setAttribute("role", "tooltip")
  tip.hidden = true
  label = document.createElement("span")
  tip.appendChild(label)
  document.body.appendChild(tip)
  return tip
}

function show(instant: boolean): void {
  if (!owner?.isConnected) return release()
  const box = ensureTip()
  window.clearTimeout(hideTimer)
  label!.textContent = held
  box.hidden = false
  box.removeAttribute("data-state")
  box.style.translate = "-9999px 0"
  const anchor = owner.getBoundingClientRect()
  const { width, height } = box.getBoundingClientRect()
  const below = anchor.bottom + GAP + height <= window.innerHeight - EDGE
  const x = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE), window.innerWidth - width - EDGE)
  const y = below ? anchor.bottom + GAP : anchor.top - GAP - height
  box.dataset.side = below ? "bottom" : "top"
  box.style.setProperty("--tip-line", String(Math.min(1, 2 / Math.max(height, 1))))
  box.style.translate = `${Math.round(x)}px ${Math.round(y)}px`
  // restart the animation even when the same box is reused
  void box.offsetWidth
  box.dataset.state = instant ? "instant" : "unfold"
  shown = true
}

/** Give the title back and close the tip. `quiet`: a new owner is taking over at once. */
function release(quiet = false): void {
  window.clearTimeout(timer)
  watch?.disconnect()
  watch = null
  if (owner) {
    // React may have set a newer title meanwhile; only put ours back if none is there
    if (!owner.hasAttribute("title") && held) owner.setAttribute("title", held)
    owner = null
    held = ""
  }
  if (!shown || !tip) return
  shown = false
  warmUntil = performance.now() + WARM_FOR
  if (quiet) {
    tip.hidden = true
    return
  }
  tip.dataset.state = "out"
  const closing = tip
  hideTimer = window.setTimeout(() => {
    if (!shown) closing.hidden = true
  }, OUT_MS)
}
