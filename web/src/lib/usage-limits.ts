import type { HarnessLimitsEntry, LimitWindow } from "./types"

/**
 * The top bar's usage ring and popover, as pure reads of
 * `GET /api/harness-limits`, so every choice they make is tested without a
 * DOM. The daemon owns every number; this file owns only which one to show
 * and how to say when it resets.
 */

/** At or past this much used, a window is worth a glance: the ring and its bar turn amber. */
export const LIMIT_WARN_PERCENT = 80

/** At or past this much used, a window reads as reached: red a step before the hard stop, while there is still time to act. */
export const LIMIT_REACHED_PERCENT = 99

export type LimitTone = "normal" | "warn" | "reached"

export function limitTone(usedPercent: number): LimitTone {
  if (usedPercent >= LIMIT_REACHED_PERCENT) return "reached"
  if (usedPercent >= LIMIT_WARN_PERCENT) return "warn"
  return "normal"
}

/**
 * The windows that speak for a harness on the ring: its main allowance. A
 * per-model window (claude's week for one model) limits only that model, and
 * a second pool (droid's core) is a small side allowance, so neither says
 * whether the next turn runs. The main pool is the unnamed one, or, when every
 * window is pooled, the first the daemon sent (droid's standard).
 */
export function mainWindows(windows: LimitWindow[]): LimitWindow[] {
  const everyModel = windows.filter((w) => !w.model)
  const pool = everyModel.some((w) => w.pool === null) ? null : (everyModel[0]?.pool ?? null)
  return everyModel.filter((w) => w.pool === pool)
}

export interface RingReading {
  /** the window the arc fills with */
  window: LimitWindow
  tone: LimitTone
  /** the most-used OTHER main window at its limit, which is why a short arc can be red; null when none is */
  reached: LimitWindow | null
}

/**
 * What the ring says for a harness. The arc is the shortest main window,
 * because it is the one that moves turn to turn: claude's 5h, a codex plan's
 * 5h, or its 7d when the plan has no 5h. A window with no fixed length (a
 * month, credits) is shown only when there is nothing else. The colour is the
 * arc's own, unless another main window has reached its limit: the next turn
 * stops either way, so the ring turns red. Null when the harness has no
 * limits to show, which leaves the ring an empty track.
 */
export function ringReading(entry: HarnessLimitsEntry | undefined): RingReading | null {
  const windows = entry?.status === "ok" ? mainWindows(entry.limits?.windows ?? []) : []
  let window = windows[0]
  if (window === undefined) return null
  for (const w of windows) {
    if (w.windowMins !== null && (window.windowMins === null || w.windowMins < window.windowMins)) window = w
  }
  let reached: LimitWindow | null = null
  for (const w of windows) {
    if (w !== window && w.usedPercent >= LIMIT_REACHED_PERCENT && (reached === null || w.usedPercent > reached.usedPercent)) {
      reached = w
    }
  }
  return { window, tone: reached ? "reached" : limitTone(window.usedPercent), reached }
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
 * does (frontend.md §5h). A red ring over a short arc names the window that
 * made it red, since the colour alone cannot be heard.
 */
export function usageTriggerLabel(harness: string | null, reading: RingReading | null): string {
  if (harness === null || reading === null) return "Usage limits"
  const used = (w: LimitWindow) => `${windowName(w)} ${Math.round(w.usedPercent)}% used`
  const label = `Usage limits, ${harness} ${used(reading.window)}`
  return reading.reached ? `${label}, ${used(reading.reached)}` : label
}
