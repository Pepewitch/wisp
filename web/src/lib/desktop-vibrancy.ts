import { getCurrentWindow } from "@tauri-apps/api/window"

import { themeStore, type Theme, type ThemePreference } from "@/lib/theme"

/**
 * Desktop's sidebar is glass: the window is transparent over macOS's sidebar
 * material (`windowEffects` in tauri.conf.json), and the sidebar paints a tint
 * over it rather than an opaque surface (`vibrancy:` in index.css).
 *
 * The material follows the WINDOW's appearance, not the page's. Wisp defaults
 * to dark whatever the Mac is set to, so a light Mac would put a pale material
 * under a dark tint and the column would read as grey. The window is therefore
 * told the theme on screen — and, for `system`, told nothing, so it follows
 * the Mac again and the page's own `prefers-color-scheme` query keeps working.
 *
 * Called once from main.tsx, Desktop only, before the first render.
 */
export function initDesktopVibrancy(): void {
  document.documentElement.dataset.vibrancy = ""
  let applied: Theme | null | undefined
  const sync = () => {
    const next = windowTheme(themeStore.preference(), themeStore.theme())
    if (next === applied) return
    applied = next
    getCurrentWindow()
      .setTheme(next)
      .catch((error: unknown) => console.warn("[wisp] could not match the window's appearance to the theme", error))
  }
  themeStore.subscribe(sync)
  sync()
}

/** null hands the appearance back to the Mac. */
export function windowTheme(preference: ThemePreference, theme: Theme): Theme | null {
  return preference === "system" ? null : theme
}
