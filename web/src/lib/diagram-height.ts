/**
 * How tall a rendered mermaid diagram is, remembered across fences.
 *
 * The viewer opened at 288px because that is a reasonable first look, not
 * because it is the right size for any particular chart: a wide flow zoomed
 * out far enough to fit left nothing to work in. The bottom edge drags, and
 * the last height a person chose becomes the default for every diagram after
 * it — resizing each fence in a transcript by hand is the same complaint one
 * step later.
 *
 * Pure layout, so the preference is global rather than connection-scoped, and
 * storage is hand-editable, so every read is clamped rather than trusted.
 */
const KEY = "wisp_mermaid_height"

export const MIN_DIAGRAM_HEIGHT = 160
export const MAX_DIAGRAM_HEIGHT = 1200
export const DEFAULT_DIAGRAM_HEIGHT = 288

/** A height inside the viewer's bounds, or the default for anything else. */
export function clampDiagramHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_DIAGRAM_HEIGHT
  return Math.min(MAX_DIAGRAM_HEIGHT, Math.max(MIN_DIAGRAM_HEIGHT, Math.round(height)))
}

/** The remembered height, or the default when nothing usable is stored. */
export function readDiagramHeight(storage?: Pick<Storage, "getItem">): number {
  try {
    const raw = (storage ?? localStorage).getItem(KEY)
    if (!raw) return DEFAULT_DIAGRAM_HEIGHT
    return clampDiagramHeight(Number(raw))
  } catch {
    return DEFAULT_DIAGRAM_HEIGHT
  }
}

/** Remember a height for the next diagram. Storage can be full or denied. */
export function writeDiagramHeight(height: number, storage?: Pick<Storage, "setItem">): void {
  try {
    ;(storage ?? localStorage).setItem(KEY, String(clampDiagramHeight(height)))
  } catch {
    // a private window or a full quota is not worth failing a drag over
  }
}
