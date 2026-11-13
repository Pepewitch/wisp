/**
 * The shortest time between two returns to the app that each count. One
 * return fires both `focus` and `visibilitychange`, and focus flickers (a
 * dialog, a click into devtools), so anything closer than this is the same
 * return.
 */
export const RETURN_REFRESH_GAP_MS = 15_000

/**
 * Calls `fn` when the person comes back to Wisp from another app or tab: the
 * window regains focus (Desktop, where switching apps leaves the page
 * visible) or the page becomes visible again (a browser tab). At most once
 * per `RETURN_REFRESH_GAP_MS`.
 */
export function onReturnToApp(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  let last = Number.NEGATIVE_INFINITY
  const returned = () => {
    if (document.visibilityState === "hidden") return
    const now = Date.now()
    if (now - last < RETURN_REFRESH_GAP_MS) return
    last = now
    fn()
  }
  window.addEventListener("focus", returned)
  document.addEventListener("visibilitychange", returned)
  return () => {
    window.removeEventListener("focus", returned)
    document.removeEventListener("visibilitychange", returned)
  }
}
