/**
 * Whether this screen should move at all. Motion that JavaScript schedules
 * (a glide's start, a box kept on screen while it leaves) asks here; motion
 * that is only CSS turns itself off in `index.css`. A runtime with no
 * `matchMedia` (jsdom) is answered as still, so nothing waits on a
 * transition that can never end.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}
