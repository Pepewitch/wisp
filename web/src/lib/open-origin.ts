import { memo, useState, type CSSProperties, type ReactNode } from "react"

/**
 * Where a preview popup grows from: the point you clicked to open it.
 *
 * The preview popups are fully controlled — a file link in prose, a row in
 * Changes, an image chip, an output tile all just set state — so there is no
 * trigger element for the primitive to measure. Instead one capture-phase
 * listener remembers the last pointer press, and the popup reads it at the
 * moment it opens. Opened from the keyboard, the focused control stands in for
 * the pointer; with neither, the popup grows from its own centre.
 *
 * The point goes out as two custom properties (`--open-x` / `--open-y`, in
 * viewport px). The popup is centred, so `.wisp-zoom` in index.css turns them
 * into a `transform-origin` with plain calc — nothing measures the popup.
 */

/** a press older than this did not open what is opening now */
const FRESH_MS = 1000

let last: { x: number; y: number; at: number } | null = null

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      last = { x: e.clientX, y: e.clientY, at: performance.now() }
    },
    { capture: true, passive: true },
  )
}

function openPoint(): { x: number; y: number } | null {
  if (last && performance.now() - last.at < FRESH_MS) return { x: last.x, y: last.y }
  const focused = typeof document === "undefined" ? null : document.activeElement
  if (focused && focused !== document.body) {
    const r = focused.getBoundingClientRect()
    if (r.width > 0 || r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  return null
}

/**
 * The style that places a `.wisp-zoom` popup's origin. Taken once as `open`
 * turns true and kept through the close, so the popup shrinks back to where it
 * came from.
 */
export function useOpenOrigin(open: boolean): CSSProperties | undefined {
  const [seen, setSeen] = useState(open)
  const [point, setPoint] = useState(() => (open ? openPoint() : null))
  if (seen !== open) {
    setSeen(open)
    if (open) setPoint(openPoint())
  }
  if (!point) return undefined
  return { "--open-x": `${point.x}px`, "--open-y": `${point.y}px` } as CSSProperties
}

/**
 * Keeps showing what a popup last showed while it closes. A controlled popup's
 * owner clears its state on close (the index, the path, the attachment), and
 * without this the box would shrink away empty: the zoom out would be an
 * invisible one. While `closing`, the last render stands.
 */
export const HoldWhileClosing = memo(
  function HoldWhileClosing({ children }: { closing: boolean; children: ReactNode }) {
    return children
  },
  (_, next) => next.closing,
)
