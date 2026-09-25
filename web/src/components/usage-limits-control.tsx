import { Popover } from "@base-ui/react/popover"

import { Refresh } from "@/components/icons"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { useRefreshHarnessLimits } from "@/hooks/mutations"
import { useHarnessFeatures, useHarnessLimits } from "@/hooks/queries"
import { useTick } from "@/hooks/useTick"
import { fromNow } from "@/lib/time"
import type { HarnessLimitsEntry, LimitWindow } from "@/lib/types"
import {
  limitTone,
  resetsIn,
  ringWindow,
  usageTriggerLabel,
  windowPools,
  type LimitTone,
} from "@/lib/usage-limits"
import { cn } from "@/lib/utils"

/** An answer older than this is re-read when the popover opens; the poll alone could leave it a minute old. */
const STALE_ON_OPEN_MS = 30_000

const ARC: Record<LimitTone, string> = {
  normal: "stroke-fg-secondary",
  warn: "stroke-state-needs-input",
  reached: "stroke-destructive",
}

const BAR: Record<LimitTone, string> = {
  normal: "bg-fg-secondary",
  warn: "bg-state-needs-input",
  reached: "bg-destructive",
}

/**
 * The top bar's usage limits: a ring for the selected task's harness, and a
 * popover with every harness's plan windows (frontend.md §5h). The daemon
 * reads and caches the limits (`GET /api/harness-limits`); a daemon without
 * that route never advertises `features.harnessLimits`, and then there is no
 * control at all rather than an icon that can only fail.
 */
export function UsageLimitsControl({
  harness,
  mobile = false,
  onOpenSettings,
}: {
  /** the selected task's harness; null leaves the ring an empty track */
  harness: string | null
  mobile?: boolean
  onOpenSettings: () => void
}) {
  const features = useHarnessFeatures()
  const supported = features.data?.harnessLimits === true
  const limits = useHarnessLimits(supported)
  const refresh = useRefreshHarnessLimits()
  if (!supported) return null

  return (
    <UsageLimitsPopover
      entries={limits.data}
      error={limits.error}
      harness={harness}
      mobile={mobile}
      refreshing={refresh.isPending || limits.isFetching}
      onRefresh={() => refresh.mutate()}
      onOpen={() => {
        if (Date.now() - limits.dataUpdatedAt > STALE_ON_OPEN_MS) void limits.refetch()
      }}
      onOpenSettings={onOpenSettings}
    />
  )
}

export function UsageLimitsPopover({
  entries,
  error = null,
  harness,
  mobile = false,
  refreshing = false,
  onRefresh,
  onOpen,
  onOpenSettings,
  defaultOpen = false,
}: {
  entries: HarnessLimitsEntry[] | undefined
  error?: Error | null
  harness: string | null
  mobile?: boolean
  refreshing?: boolean
  onRefresh: () => void
  onOpen?: () => void
  onOpenSettings: () => void
  /** Gallery/test seam. Production leaves the surface closed initially. */
  defaultOpen?: boolean
}) {
  const focused = harness === null ? undefined : entries?.find((e) => e.name === harness)
  const window = ringWindow(focused)

  return (
    <Popover.Root
      defaultOpen={defaultOpen}
      onOpenChange={(open) => {
        if (open) onOpen?.()
      }}
    >
      {/* Hover opens it and a click pins it open, on a pointer; a finger has
          no hover, so on touch it is a tap like the drawer's other controls. */}
      <Popover.Trigger
        openOnHover={!mobile}
        delay={150}
        closeDelay={200}
        render={<Button size={mobile ? "lg" : "sm"} icon />}
        aria-label={usageTriggerLabel(focused ? harness : null, window)}
      >
        <UsageRing window={window} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={12} className="z-(--z-menu)">
          <Popover.Popup
            className={cn(POPOVER_SURFACE, "w-[360px] max-w-[calc(100vw-24px)] rounded-xl p-3 outline-none")}
          >
            <UsageLimitsPanel
              entries={entries}
              error={error}
              harness={harness}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onOpenSettings={onOpenSettings}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/**
 * A progress ring the size of a glyph. The track is always drawn, so "no
 * task, or a harness with no limits read" is an empty ring rather than a
 * missing icon, and the arc fills with the share USED, as every harness's
 * own report words it.
 */
export function UsageRing({ window }: { window: LimitWindow | null }) {
  const used = window === null ? 0 : Math.max(0, Math.min(100, window.usedPercent))
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" strokeWidth={2.25}>
      <circle cx={8} cy={8} r={6} className="stroke-border-strong" />
      {used > 0 && window !== null && (
        <circle
          cx={8}
          cy={8}
          r={6}
          pathLength={100}
          strokeDasharray={`${used} 100`}
          transform="rotate(-90 8 8)"
          className={ARC[limitTone(window.usedPercent)]}
        />
      )}
    </svg>
  )
}

function UsageLimitsPanel({
  entries,
  error,
  harness,
  refreshing,
  onRefresh,
  onOpenSettings,
}: {
  entries: HarnessLimitsEntry[] | undefined
  error: Error | null
  harness: string | null
  refreshing: boolean
  onRefresh: () => void
  onOpenSettings: () => void
}) {
  // the popover is the only reader of "resets in", so the clock ticks only while it is open
  const now = useTick(true)
  const oldest = entries?.reduce<string | null>((at, e) => (at === null || e.fetchedAt < at ? e.fetchedAt : at), null)

  return (
    <>
      <Popover.Title className="text-[13px] font-semibold">Usage limits</Popover.Title>
      <div className="mt-2 divide-y divide-border">
        {entries === undefined ? (
          <p className={cn("pb-1 text-[11.5px]", error ? "text-destructive" : "text-muted-foreground")}>
            {error ? `Could not read usage limits: ${error.message}` : "Reading usage limits…"}
          </p>
        ) : entries.length === 0 ? (
          <p className="pb-1 text-[11.5px] text-muted-foreground">No harness on this daemon reports plan limits.</p>
        ) : (
          entries.map((entry) => (
            <HarnessSection
              key={entry.name}
              entry={entry}
              focused={entry.name === harness}
              now={now}
              onOpenSettings={onOpenSettings}
            />
          ))
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
        <span className="text-[11px] text-faint">{oldest ? `Updated ${fromNow(oldest, now)}` : ""}</span>
        <Button size="sm" disabled={refreshing} onClick={onRefresh}>
          <Refresh />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </>
  )
}

function HarnessSection({
  entry,
  focused,
  now,
  onOpenSettings,
}: {
  entry: HarnessLimitsEntry
  focused: boolean
  now: number
  onOpenSettings: () => void
}) {
  const pools = entry.limits ? windowPools(entry.limits.windows) : []
  const headed = pools.length > 1 || (pools.length === 1 && pools[0]!.pool !== null)
  return (
    <section aria-label={`${entry.name} usage limits`} className="py-2.5 first:pt-0 last:pb-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="shrink-0 text-[12.5px] font-medium">
          {entry.name}
          {focused && <span className="ml-1.5 text-[10.5px] font-normal text-faint">this task</span>}
        </h3>
        {entry.limits?.plan && (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-faint" title={entry.limits.plan}>
            {entry.limits.plan}
          </span>
        )}
      </div>
      {entry.status === "ok" && entry.limits ? (
        <>
          {pools.map((pool) => (
            <div key={pool.pool ?? ""} className="mt-1.5">
              {headed && <p className="mb-1 text-[10.5px] text-faint">{pool.pool ?? "default"}</p>}
              <ul className="space-y-1">
                {pool.windows.map((window) => (
                  <WindowRow key={window.id} window={window} now={now} />
                ))}
              </ul>
            </div>
          ))}
          {entry.limits.account === "unchecked" && (
            <p className="mt-1.5 text-[11px] text-faint">Not checked against droid&apos;s login.</p>
          )}
        </>
      ) : (
        <HarnessNote entry={entry} onOpenSettings={onOpenSettings} />
      )}
    </section>
  )
}

/** Why a harness shows no windows. Only a real failure is red; a harness that has none to report is not one. */
function HarnessNote({ entry, onOpenSettings }: { entry: HarnessLimitsEntry; onOpenSettings: () => void }) {
  const needsSettings = entry.status === "needs-key" || entry.status === "account-mismatch"
  return (
    <div className="mt-1 flex items-start justify-between gap-3">
      <p
        className={cn(
          "min-w-0 text-[11px] leading-normal",
          entry.status === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {entry.message ?? "No limits to show."}
      </p>
      {needsSettings && (
        <Button size="sm" tone="outline" onClick={onOpenSettings}>
          Settings…
        </Button>
      )}
    </div>
  )
}

function WindowRow({ window, now }: { window: LimitWindow; now: number }) {
  const used = Math.max(0, Math.min(100, window.usedPercent))
  const reset = resetsIn(window.resetsAt, now)
  return (
    <li className="flex items-center gap-2.5">
      <span className="w-16 shrink-0 truncate text-[11.5px] text-fg-secondary" title={window.label}>
        {window.label}
      </span>
      <span
        role="meter"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border-strong"
      >
        <span
          className={cn("block h-full rounded-full", BAR[limitTone(window.usedPercent)])}
          style={{ width: `${used}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">
        {Math.round(window.usedPercent)}%
      </span>
      <span
        className="w-[88px] shrink-0 truncate text-[10.5px] text-faint"
        title={window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : undefined}
      >
        {reset ? `resets ${reset}` : ""}
      </span>
    </li>
  )
}
