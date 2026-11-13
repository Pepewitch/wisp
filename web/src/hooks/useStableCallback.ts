import { useCallback, useLayoutEffect, useRef } from "react"

/**
 * A callback whose identity never changes but which always runs the latest
 * `fn`. For a parent that rebuilds its handlers every render while the
 * memoized rows below it should not redraw for that. Only for event handlers:
 * calling it during render would read the previous render's `fn`.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
