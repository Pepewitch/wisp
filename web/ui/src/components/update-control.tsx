import { Button } from "@/components/primitives"
import type { UpdateStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

export function WispUpdateControl({
  status,
  updating,
  error,
  onUpdate,
}: {
  status: UpdateStatus | undefined
  updating: boolean
  error: string | null
  onUpdate: (version: string) => void
}) {
  if (!status) return null

  const target = status.latestVersion
  const busy = !error && (updating || status.state === "installing" || status.state === "restarting")
  if (target && busy) {
    return (
      <Button size="sm" disabled title={`Installing Wisp ${target}`}>
        Updating…
      </Button>
    )
  }

  if (target && status.canAutoUpdate && (status.state === "available" || status.state === "failed")) {
    return (
      <Button
        size="sm"
        tone="outline"
        onClick={() => onUpdate(target)}
        title={error ?? status.message ?? `Install Wisp ${target} and restart`}
      >
        {status.state === "failed" || error ? "Retry update" : `Update ${target}`}
      </Button>
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
      title={title}
    >
      {error ? "Update failed" : status.currentVersion}
    </span>
  )
}
