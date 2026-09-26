import { useConnectionStreamStatus } from "@/hooks/useConnectionStreamStatus"
import { useDaemonRuntime } from "@/lib/runtime"
/** On a phone the drawer is closed while reading; reconnects must remain visible. */
export function MobileConnectionStatus() {
  const { connectionId } = useDaemonRuntime()
  const { status, delayed } = useConnectionStreamStatus(connectionId)
  if (status !== "failed" && !delayed) return null
  return (
    <div role="status" className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
      {status === "failed" ? "Live updates disconnected." : "Live updates delayed."} Check your connection and Tailscale.
    </div>
  )
}
