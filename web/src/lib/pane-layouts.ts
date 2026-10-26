/**
 * Where the shell's pane layouts live between visits (`components/panes.tsx`).
 *
 * The layouts themselves are the resizable-panels library's: it stores each
 * group under its id, and `useDefaultLayout` reads it back. This file holds
 * the ids, the one-time move from the always-open right column's layouts,
 * and the tool panel's open width, which the library cannot keep because a
 * collapsed panel's layout says 0.
 */

/**
 * The library's own storage keys. `-v2` and `-dock` are the tools-on-demand
 * layouts; the two before them were the always-open right column (its panel
 * was `right`) and its Changes-over-Terminal split.
 */
export const MAIN_LAYOUT_ID = "wisp-ui-main-v2"
export const DOCK_LAYOUT_ID = "wisp-ui-dock"
const LEGACY_MAIN_LAYOUT_ID = "wisp-ui-main"
const LEGACY_RIGHT_LAYOUT_ID = "wisp-ui-right"
const layoutKey = (id: string) => `react-resizable-panels:${id}`

/** The tool panel's open width, one for every task, in px so a window resize leaves it alone. */
const PANEL_WIDTH_KEY = "wisp_tool_panel_width"
export const PANEL_MIN_WIDTH = 320
const PANEL_DEFAULT_WIDTH = 420

type LayoutStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function numbers(raw: string | null, ids: readonly string[]): Record<string, number> | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null")
    if (!value || typeof value !== "object") return null
    const layout = value as Record<string, unknown>
    return ids.every((id) => typeof layout[id] === "number") ? (layout as Record<string, number>) : null
  } catch {
    return null
  }
}

/**
 * Carry the always-open right column's saved layouts over, once, before the
 * library reads its new ids.
 *
 * The old main layout gave `right` its share; the panel now starts closed, so
 * that share goes back to the centre and is remembered as the panel's open
 * width instead. The old split becomes the dock's split (`changes` was the
 * upper panel, now `tool`). An unreadable layout is dropped rather than
 * guessed at, so nobody opens to a broken one: the library's defaults are
 * the fallback. This is the one place layout JSON is written by hand.
 */
export function migrateSavedLayouts(storage: LayoutStorage = localStorage, windowWidth = globalThis.innerWidth ?? 0): void {
  try {
    const legacyMain = storage.getItem(layoutKey(LEGACY_MAIN_LAYOUT_ID))
    if (legacyMain !== null) {
      const old = numbers(legacyMain, ["sidebar", "centre"])
      if (old && storage.getItem(layoutKey(MAIN_LAYOUT_ID)) === null) {
        const right = typeof old.right === "number" ? old.right : 0
        storage.setItem(layoutKey(MAIN_LAYOUT_ID), JSON.stringify({ sidebar: old.sidebar, centre: old.centre! + right, tool: 0 }))
        if (right > 0 && windowWidth > 0 && storage.getItem(PANEL_WIDTH_KEY) === null) {
          storage.setItem(PANEL_WIDTH_KEY, String(Math.max(PANEL_MIN_WIDTH, Math.round((right / 100) * windowWidth))))
        }
      }
      storage.removeItem(layoutKey(LEGACY_MAIN_LAYOUT_ID))
    }
    const legacyRight = storage.getItem(layoutKey(LEGACY_RIGHT_LAYOUT_ID))
    if (legacyRight !== null) {
      const old = numbers(legacyRight, ["changes", "terminal"])
      if (old && storage.getItem(layoutKey(DOCK_LAYOUT_ID)) === null) {
        storage.setItem(layoutKey(DOCK_LAYOUT_ID), JSON.stringify({ tool: old.changes, terminal: old.terminal }))
      }
      storage.removeItem(layoutKey(LEGACY_RIGHT_LAYOUT_ID))
    }
  } catch {
    // blocked storage: the library's defaults, which is all a fresh install has
  }
}

export function readPanelWidth(): number {
  try {
    const width = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    return Number.isFinite(width) && width >= PANEL_MIN_WIDTH ? width : PANEL_DEFAULT_WIDTH
  } catch {
    return PANEL_DEFAULT_WIDTH
  }
}

export function writePanelWidth(px: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(px)))
  } catch {
    // blocked storage costs only the remembered width
  }
}
