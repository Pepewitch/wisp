import { Button } from "@/components/primitives"
import type { UpdateStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

export function WispUpdateControl({
  status,
  updating,
  error,
  onUpdate,
  supportedApiProtocolVersion,
  connectionName,
}: {
  status: UpdateStatus | undefined
  updating: boolean
  error: string | null
  onUpdate: (version: string) => void
  /** Present only in Desktop, whose native proxy has a fixed daemon contract. */
  supportedApiProtocolVersion?: number
  /** Present only in Desktop, where updates must name their daemon scope. */
  connectionName?: string
}) {
  if (!status) return null

  const scoped = (message: string) =>
    connectionName ? `${message} — ${connectionName}` : message
  const target = status.latestVersion
  const incompatible =
    target !== null &&
    supportedApiProtocolVersion !== undefined &&
    (status.currentApiProtocolVersion !== supportedApiProtocolVersion ||
      status.latestApiProtocolVersion !== supportedApiProtocolVersion)
  const busy = !error && (updating || status.state === "installing" || status.state === "restarting")
  if (target && busy) {
    return (
      <Button size="sm" disabled title={scoped(`Installing Wisp ${target}`)}>
        Updating…
      </Button>
    )
  }

  if (
    target &&
    !incompatible &&
    status.canAutoUpdate &&
    (status.state === "available" || status.state === "failed")
  ) {
    return (
      <Button
        size="sm"
        tone="outline"
        onClick={() => onUpdate(target)}
        title={scoped(error ?? status.message ?? `Install Wisp ${target} and restart`)}
      >
        {status.state === "failed" || error ? "Retry update" : `Update ${target}`}
      </Button>
    )
  }

  if (incompatible) {
    return (
      <span
        className="text-[11.5px] text-warning"
        title={scoped(
          `Wisp ${target} uses API protocol ${status.latestApiProtocolVersion ?? "unknown"}; this Desktop supports protocol ${supportedApiProtocolVersion}`
        )}
      >
        Update blocked
      </span>
    )
  }

  const title =
    error ??
    status.message ??
    (target && status.state === "available"
      ? `Wisp ${target} is available; this installation updates manually`
      : `Wisp ${status.currentVersion}`)
  return (
    <span
      className={cn(
        error && "text-[11.5px] text-destructive",
        !error && "font-mono text-[10.5px] text-faint",
      )}
      title={scoped(title)}
    >
      {error ? "Update failed" : status.currentVersion}
    </span>
  )
}
