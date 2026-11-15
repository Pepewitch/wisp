import { useMinuteTick } from "@/hooks/useTick"
import type { DesktopUpdateStatus } from "@/lib/desktop-bridge"
import { fromNow, instantOf, utcIso } from "@/lib/time"
import { cn } from "@/lib/utils"

/** A local error or protocol block wins over the daemon's own message. */
export function DaemonRowMessage({
  problem,
  message,
  failed,
}: {
  problem: string | null
  message: string | null
  failed: boolean
}) {
  const text = problem ?? message
  if (!text) return null
  return (
    <p
      className={cn(
        "mt-1 text-[11px] leading-normal",
        problem || failed ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {text}
    </p>
  )
}

/**
 * When this row last reached its release channel, so "nothing to install"
 * carries its age. Nothing before the first check, or while one runs.
 */
export function CheckedAt({ at }: { at: string | null | undefined }) {
  const now = useMinuteTick(Boolean(at))
  if (!at) return null
  // A clock shared since before the check can trail it; never say "in 1 min".
  const ago = fromNow(at, Math.max(now, instantOf(at)))
  if (!ago) return null
  return (
    <p className="mt-0.5 text-[10.5px] text-faint" title={utcIso(at)}>
      Checked {ago}
    </p>
  )
}

export function DesktopCheckedAt({
  status,
}: {
  status: DesktopUpdateStatus | null
}) {
  return (
    <CheckedAt at={status?.phase === "checking" ? null : status?.checkedAt} />
  )
}

export function VersionLine({
  current,
  latest,
}: {
  current: string | undefined
  latest: string | null | undefined
}) {
  return (
    <span className="shrink-0 font-mono text-[10.5px] text-faint">
      {current ?? "Checking…"}
      {latest && latest !== current ? ` → ${latest}` : ""}
    </span>
  )
}
