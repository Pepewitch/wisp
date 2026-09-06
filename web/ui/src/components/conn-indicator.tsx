import { useSyncExternalStore } from "react"

import { connectionStore } from "@/lib/conn"
import { useDaemonRuntime } from "@/lib/runtime"
import { cn } from "@/lib/utils"

/** Presentational, so the gallery can render both states without a socket. */
export function ConnStatus({ live }: { live: boolean }) {
  return (
    <span data-live={live} className="flex items-center gap-1.5">
      <span className={cn("size-[5px] rounded-full", live ? "bg-state-done" : "animate-pulse bg-state-needs-input")} />
      <span className="text-[11.5px] text-muted-foreground">{live ? "Live" : "Reconnecting…"}</span>
    </span>
  )
}

/** "Live" only while BOTH SSE streams are healthy (lib/conn.ts). */
export function ConnIndicator() {
  const { connectionId } = useDaemonRuntime()
  const store = connectionStore(connectionId)
  const live = useSyncExternalStore(store.subscribe, store.isLive)
  return <ConnStatus live={live} />
}
