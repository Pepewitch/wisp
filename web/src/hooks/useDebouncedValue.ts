import { useEffect, useState } from "react"

/**
 * A value that lags its source by `delay`, for the one thing that needs it:
 * a search box that asks a daemon. Without it every keystroke is its own
 * query key and therefore its own request — cheap against a local SQLite
 * scan, rude over a tailscale link to a remote daemon.
 *
 * The timer is what sets state, never the effect body, so a render is never
 * cascaded by one.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (settled === value) return
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [delay, settled, value])
  return settled
}
