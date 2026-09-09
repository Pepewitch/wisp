import { useSyncExternalStore } from "react"

/**
 * Which end of the scale the app paints in.
 *
 * Wisp is a dark app by design, so `dark` is the DEFAULT rather than the
 * system's answer: an update must not silently repaint everyone's window
 * because their Mac happens to be in light mode. `system` is offered for
 * people who want the app to follow the OS, and `light` for people who just
 * want light — the two reasons this exists at all.
 *
 * The preference is client-local and global. It is not connection-scoped:
 * theme is not daemon state, and switching tabs must not switch the theme
 * (the frontend reference's one explicit exception, alongside pane layout).
 */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** What is actually on screen. `system` resolves to one of these. */
export type Theme = "light" | "dark"

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "dark"

const STORAGE_KEY = "wisp_theme"
const DARK_QUERY = "(prefers-color-scheme: dark)"

function isPreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
}

/** A blocked or empty store is not a preference — it is the default. */
export function readThemePreference(storage?: Storage): ThemePreference {
  try {
    const stored = (storage ?? localStorage).getItem(STORAGE_KEY)
    return isPreference(stored) ? stored : DEFAULT_THEME_PREFERENCE
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
}

export function writeThemePreference(preference: ThemePreference, storage?: Storage): void {
  try {
    const target = storage ?? localStorage
    target.setItem(STORAGE_KEY, preference)
  } catch {
    // Private-mode storage refuses writes. The choice still applies to this
    // window; only its survival across a reload is lost.
  }
}

/** The OS answer, and `dark` wherever the question cannot be asked. */
export function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark"
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light"
}

export function resolveTheme(preference: ThemePreference, system: Theme): Theme {
  return preference === "system" ? system : preference
}

/**
 * The window chrome a platform paints for itself, in the one form it accepts:
 * a meta tag rather than a token.
 *
 * `color-scheme` also rides in the CSS token blocks, and the CSS property wins
 * once the stylesheet is parsed — the meta is what answers BEFORE that, which
 * matters here because the bundle is one file and its <style> follows 1.8 MB
 * of inlined module. Both are written from one place so they cannot disagree.
 *
 * `theme-color` tints a mobile browser's OWN toolbar above the app; both
 * values match the top bar's surface. scripts/brand/build.ts writes the dark
 * value into index.html too.
 */
const CHROME_COLOR: Record<Theme, string> = { dark: "#19191d", light: "#f6f6f9" }

function setMeta(name: string, content: string): void {
  const existing = document.head.querySelector(`meta[name="${name}"]`)
  if (existing) {
    existing.setAttribute("content", content)
    return
  }
  const meta = document.createElement("meta")
  meta.name = name
  meta.content = content
  document.head.append(meta)
}

/**
 * Writes the theme onto <html>, which is the ONE place either class is set,
 * and tells the platform the same thing through its two metas.
 *
 * This is what makes the platform paint its own scrollbar, caret and form
 * controls in the right theme — the bug that started this: a dark app on a
 * light-appearance Mac showed a white native scrollbar on hover.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle("dark", theme === "dark")
  root.classList.toggle("light", theme === "light")
  setMeta("color-scheme", theme)
  setMeta("theme-color", CHROME_COLOR[theme])
}

let preference = readThemePreference()
let system = systemTheme()
let watching = false
let watchingStorage = false
const listeners = new Set<() => void>()

function announce(): void {
  applyTheme(resolveTheme(preference, system))
  for (const listener of listeners) listener()
}

/**
 * The OS can change appearance while the app is open (macOS at sunset, and
 * the packaged app's webview follows the system there too), so `system` is a
 * live query rather than a value read at startup.
 */
function watchSystem(): void {
  if (watching || typeof window === "undefined" || typeof window.matchMedia !== "function") return
  watching = true
  window.matchMedia(DARK_QUERY).addEventListener("change", (event) => {
    system = event.matches ? "dark" : "light"
    if (preference === "system") announce()
  })
}

/**
 * Two browser tabs on one daemon is a real surface, and the preference they
 * share is one key. `storage` fires only in the OTHER tabs, which is exactly
 * what this needs; a `clear()` (the desktop reset) reports a null key, so it
 * lands here too and falls back to the default.
 *
 * Nothing is written back — the value already IS what storage holds.
 */
function watchStorage(): void {
  if (watchingStorage || typeof window === "undefined") return
  watchingStorage = true
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    const next = readThemePreference()
    if (next === preference) return
    preference = next
    announce()
  })
}

/** A tiny external store: the theme lives above every tree that reads it. */
export const themeStore = {
  subscribe(listener: () => void): () => void {
    watchSystem()
    watchStorage()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** The choice a person made. */
  preference(): ThemePreference {
    return preference
  },
  /** What is on screen — a primitive, so snapshot identity is a non-issue. */
  theme(): Theme {
    return resolveTheme(preference, system)
  },
  set(next: ThemePreference): void {
    if (next === preference) return
    preference = next
    writeThemePreference(next)
    announce()
  },
}

/**
 * Called once from main.tsx, before the first render.
 *
 * index.html ships `class="dark"` so the default theme is painted by the
 * markup itself with no script in the way — the bundle is one inlined file
 * under a `script-src 'self'` policy in the packaged app, so there is no
 * earlier hook than this. A stored `light` or a system-following preference
 * therefore costs at most one dark frame at startup, and never a flash of
 * light in a dark app.
 */
export function initTheme(): void {
  // re-read rather than trust the module's own import-time answer: nothing
  // guarantees this runs in the same frame, or that matchMedia existed then
  system = systemTheme()
  watchSystem()
  watchStorage()
  applyTheme(themeStore.theme())
}

// no SSR (the app is a client-only SPA) — the default identity is the safe
// answer for a snapshot that can never actually be taken
const serverPreference = (): ThemePreference => DEFAULT_THEME_PREFERENCE
const serverTheme = (): Theme => "dark"

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(themeStore.subscribe, themeStore.preference, serverPreference)
}

/** The resolved theme, for the rare surface that cannot read a CSS token. */
export function useTheme(): Theme {
  return useSyncExternalStore(themeStore.subscribe, themeStore.theme, serverTheme)
}
