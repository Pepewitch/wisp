/**
 * Whether an element is near its scroller's visible area, from one shared
 * IntersectionObserver per scroller: a transcript can mount hundreds of
 * images, and an observer each is hundreds of observers.
 *
 * "Near" is a screen or so of margin, so an image scrolled toward is usually
 * loaded before it arrives.
 */
const NEAR_MARGIN = "800px 0px"

type NearListener = (near: boolean) => void

interface SharedObserver {
  observer: IntersectionObserver
  targets: Map<Element, NearListener>
}

const observers = new Map<Element | null, SharedObserver>()

/**
 * Calls `listener` with the element's state now and whenever it changes.
 * Without an IntersectionObserver (an old engine, or jsdom) everything is
 * near, which is what rendering did before.
 */
export function watchNearViewport(target: Element, root: Element | null, listener: NearListener): () => void {
  if (typeof IntersectionObserver === "undefined") {
    listener(true)
    return () => {}
  }
  let shared = observers.get(root)
  if (!shared) {
    const targets = new Map<Element, NearListener>()
    const observer = new IntersectionObserver(
      (records) => { for (const record of records) targets.get(record.target)?.(record.isIntersecting) },
      { root, rootMargin: NEAR_MARGIN },
    )
    shared = { observer, targets }
    observers.set(root, shared)
  }
  const { observer, targets } = shared
  targets.set(target, listener)
  observer.observe(target)
  return () => {
    observer.unobserve(target)
    targets.delete(target)
    if (targets.size > 0) return
    observer.disconnect()
    observers.delete(root)
  }
}
