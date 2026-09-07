import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DEFAULT_THEME_PREFERENCE, themeStore } from "@/lib/theme"

import { ThemeControl } from "./theme-control"

afterEach(() => {
  themeStore.set(DEFAULT_THEME_PREFERENCE)
  localStorage.clear()
})

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Theme" }))
}

describe("the theme control", () => {
  it("picks light, applies it to <html> and remembers it", async () => {
    render(<ThemeControl />)
    openMenu()

    // the default choice is the app's own theme, and it says so
    expect(await screen.findByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    )

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }))

    expect(themeStore.theme()).toBe("light")
    expect(document.documentElement).toHaveClass("light")
    expect(localStorage.getItem("wisp_theme")).toBe("light")
  })

  it("reports which theme System landed on", async () => {
    themeStore.set("system")
    render(<ThemeControl />)
    openMenu()

    const system = await screen.findByRole("menuitemradio", { name: /System/ })
    expect(system).toHaveAttribute("aria-checked", "true")
    // jsdom implements no matchMedia, so the OS reads as dark here; the hint
    // exists to say where System landed, whatever that turns out to be
    expect(system).toHaveTextContent("dark")
  })
})
