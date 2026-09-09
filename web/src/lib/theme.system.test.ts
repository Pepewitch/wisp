import { afterEach, describe, expect, it, vi } from "vitest"

import { applyTheme, DEFAULT_THEME_PREFERENCE, initTheme, themeStore, type Theme } from "./theme"

/**
 * The live paths: the OS changing appearance under a `system` preference, the
 * platform metas, and a second tab. Its own file because the store is a module
 * singleton that installs its listeners once — the stub has to be in place
 * before anything subscribes.
 */
const changeListeners = new Set<(event: MediaQueryListEvent) => void>()
let systemDark = false

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: systemDark,
    addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => {
      changeListeners.add(fn)
    },
    removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => {
      changeListeners.delete(fn)
    },
  }))
}

/** What macOS does at sunset. */
function osBecomes(dark: boolean) {
  systemDark = dark
  for (const listener of changeListeners) listener({ matches: dark } as MediaQueryListEvent)
}

const meta = (name: string) =>
  document.head.querySelector(`meta[name="${name}"]`)?.getAttribute("content")

afterEach(() => {
  themeStore.set(DEFAULT_THEME_PREFERENCE)
  localStorage.clear()
  systemDark = false
  vi.unstubAllGlobals()
})

describe("System, while the OS changes its mind", () => {
  it("follows the appearance under `system`, and ignores it under an explicit choice", () => {
    stubMatchMedia()
    initTheme()
    themeStore.set("system")
    expect(themeStore.theme()).toBe("light")
    expect(document.documentElement).toHaveClass("light")

    const seen: Theme[] = []
    const stop = themeStore.subscribe(() => seen.push(themeStore.theme()))

    osBecomes(true)
    expect(themeStore.theme()).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")

    // an explicit choice takes the OS out of it — the flip changes nothing
    themeStore.set("light")
    osBecomes(false)
    expect(themeStore.theme()).toBe("light")
    expect(seen).toEqual(["dark", "light"])

    stop()
  })
})

describe("the platform's own chrome", () => {
  it("says the same theme in both metas, creating them if the page has none", () => {
    applyTheme("light")
    expect(meta("color-scheme")).toBe("light")
    expect(meta("theme-color")).toBe("#f6f6f9")

    applyTheme("dark")
    expect(meta("color-scheme")).toBe("dark")
    expect(meta("theme-color")).toBe("#19191d")
  })
})

describe("a second tab", () => {
  it("lands another tab's choice, and a reset that clears the key", () => {
    stubMatchMedia()
    initTheme()

    // the other tab's write, reported here as a storage event
    localStorage.setItem("wisp_theme", "light")
    window.dispatchEvent(new StorageEvent("storage", { key: "wisp_theme", newValue: "light" }))
    expect(themeStore.preference()).toBe("light")
    expect(document.documentElement).toHaveClass("light")

    // somebody else's key is not ours
    localStorage.setItem("wisp_show_archived", "1")
    window.dispatchEvent(new StorageEvent("storage", { key: "wisp_show_archived", newValue: "1" }))
    expect(themeStore.preference()).toBe("light")

    // the desktop reset clears everything, and reports a null key
    localStorage.clear()
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(themeStore.preference()).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")
  })
})
