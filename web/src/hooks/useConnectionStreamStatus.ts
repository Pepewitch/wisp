import { useEffect, useState, useSyncExternalStore } from "react"

import { connectionStore } from "@/lib/conn"

const LIVE_UPDATE_GRACE_MS = 3_000

/** A routine stream handoff gets a short grace period before it needs attention. */
export function useConnectionStreamStatus(connectionId: string, enabled = true) {
  const store = connectionStore(connectionId)
  const { status, generation } = useSyncExternalStore(
    store.subscribe,
    store.snapshot
  )
  const [delayedGeneration, setDelayedGeneration] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled || status !== "opening") return
    const timer = setTimeout(
      () => setDelayedGeneration(generation),
      LIVE_UPDATE_GRACE_MS
    )
    return () => clearTimeout(timer)
  }, [enabled, generation, status])
  return {
    status,
    delayed: status === "opening" && delayedGeneration === generation,
  }
}
