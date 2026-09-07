import { afterEach, describe, expect, it, vi } from "vitest"

import {
  applyTheme,
  DEFAULT_THEME_PREFERENCE,
  readThemePreference,
  resolveTheme,
  systemTheme,
  themeStore,
} from "./theme"

afterEach(() => {
  themeStore.set(DEFAULT_THEME_PREFERENCE)
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("theme preference", () => {
  it("defaults to dark with nothing stored, and treats junk as nothing", () => {
    expect(readThemePreference()).toBe("dark")
    localStorage.setItem("wisp_theme", "solarized")
    expect(readThemePreference()).toBe("dark")
    localStorage.setItem("wisp_theme", "light")
    expect(readThemePreference()).toBe("light")
  })

  it("survives a storage that refuses to answer", () => {
    const blocked = {
      getItem() {
        throw new Error("denied")
      },
    } as unknown as Storage
    expect(readThemePreference(blocked)).toBe("dark")
  })

  it("resolves system to whichever theme the OS is showing", () => {
    expect(resolveTheme("system", "light")).toBe("light")
    expect(resolveTheme("system", "dark")).toBe("dark")
    // an explicit choice ignores the OS entirely
    expect(resolveTheme("dark", "light")).toBe("dark")
    expect(resolveTheme("light", "dark")).toBe("light")
  })

  it("reads the OS through prefers-color-scheme, and calls it dark when it cannot ask", () => {
    // jsdom implements no matchMedia at all, which is the fallback path
    expect(systemTheme()).toBe("dark")

    const matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList)
    vi.stubGlobal("matchMedia", matchMedia)
    expect(systemTheme()).toBe("dark")
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)")

    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList)
    expect(systemTheme()).toBe("light")
  })
})

describe("applying a theme", () => {
  it("leaves exactly one class on <html>, so the token blocks cannot both win", () => {
    applyTheme("light")
    expect(document.documentElement.classList.contains("light")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    applyTheme("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.classList.contains("light")).toBe(false)
  })
})

describe("the theme store", () => {
  it("persists a choice, repaints <html> and tells its subscribers once", () => {
    const seen: string[] = []
    const stop = themeStore.subscribe(() => seen.push(themeStore.theme()))

    themeStore.set("light")
    expect(themeStore.preference()).toBe("light")
    expect(themeStore.theme()).toBe("light")
    expect(localStorage.getItem("wisp_theme")).toBe("light")
    expect(document.documentElement.classList.contains("light")).toBe(true)

    // the same choice again is not a change
    themeStore.set("light")
    expect(seen).toEqual(["light"])

    stop()
    themeStore.set("dark")
    expect(seen).toEqual(["light"])
  })
})
