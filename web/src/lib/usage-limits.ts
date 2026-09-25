import type { HarnessLimitsEntry, LimitWindow } from "./types"

/**
 * The top bar's usage ring and popover, as pure reads of
 * `GET /api/harness-limits`, so every choice they make is tested without a
 * DOM. The daemon owns every number; this file owns only which one to show
 * and how to say when it resets.
 */

/** At or past this much used, a window is worth a glance: the ring and its bar turn amber. */
export const LIMIT_WARN_PERCENT = 80

export type LimitTone = "normal" | "warn" | "reached"

export function limitTone(usedPercent: number): LimitTone {
  if (usedPercent >= 100) return "reached"
  if (usedPercent >= LIMIT_WARN_PERCENT) return "warn"
  return "normal"
}

/**
 * The window the ring shows for a harness: the one closest to running out,
 * because that is the one that stops the next turn. A tie goes to the
 * shorter window, which resets first and so is the one that moves. Null when
 * the harness has no limits to show, which leaves the ring an empty track.
 */
export function ringWindow(entry: HarnessLimitsEntry | undefined): LimitWindow | null {
  const windows = entry?.status === "ok" ? (entry.limits?.windows ?? []) : []
  let best: LimitWindow | null = null
  for (const window of windows) {
    if (
      best === null ||
      window.usedPercent > best.usedPercent ||
      (window.usedPercent === best.usedPercent && (window.windowMins ?? Infinity) < (best.windowMins ?? Infinity))
    ) {
      best = window
    }
  }
  return best
}

/** A window's name with its pool, where the harness has more than one: `core weekly`. */
export function windowName(window: LimitWindow): string {
  return window.pool ? `${window.pool} ${window.label}` : window.label
}

/**
 * `in 2h 14m`, `in 3d 4h`, `in 12m`; `""` with no reset. Floors, like the
 * app's relative clock, so 90 minutes never reads as 2h. Two units, because a
 * reset is planned around, and "in 3d" hides most of a day.
 */
export function resetsIn(iso: string | null, now: number): string {
  if (iso === null) return ""
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ""
  if (ms <= 0) return "now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The windows of one harness, grouped by pool in the order the daemon sent them. */
export function windowPools(windows: LimitWindow[]): { pool: string | null; windows: LimitWindow[] }[] {
  const pools: { pool: string | null; windows: LimitWindow[] }[] = []
  for (const window of windows) {
    const group = pools.find((p) => p.pool === window.pool)
    if (group) group.windows.push(window)
    else pools.push({ pool: window.pool, windows: [window] })
  }
  return pools
}

/**
 * What the icon says out loud. The trigger carries no text, so its name is
 * the whole readout, and it starts with the surface's own name, as Updates'
 * does (frontend.md §5h).
 */
export function usageTriggerLabel(harness: string | null, window: LimitWindow | null): string {
  if (harness === null || window === null) return "Usage limits"
  return `Usage limits, ${harness} ${windowName(window)} ${Math.round(window.usedPercent)}% used`
}
