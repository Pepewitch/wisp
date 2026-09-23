import { useSyncExternalStore } from "react"

import { connectionStore } from "@/lib/conn"
import { useDaemonRuntime } from "@/lib/runtime"
/** On a phone the drawer is closed while reading; reconnects must remain visible. */
export function MobileConnectionStatus() {
  const { connectionId } = useDaemonRuntime()
  const store = connectionStore(connectionId)
  const live = useSyncExternalStore(store.subscribe, store.isLive)
  if (live) return null
  return <div role="status" className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">Reconnecting… Check your connection and Tailscale.</div>
}
