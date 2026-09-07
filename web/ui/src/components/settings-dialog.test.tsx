import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { DEFAULT_THEME_PREFERENCE, themeStore } from "@/lib/theme"

import { SettingsDialog } from "./settings-dialog"

afterEach(() => {
  themeStore.set(DEFAULT_THEME_PREFERENCE)
  localStorage.clear()
})

function openThemeMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Theme" }))
}

describe("Wisp settings", () => {
  it("picks light from the appearance section, applies it and remembers it", async () => {
    render(<SettingsDialog open onOpenChange={() => {}} />)

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument()
    // the trigger reads as the field, and shows the value it holds
    expect(screen.getByRole("button", { name: "Theme" })).toHaveTextContent("Dark")

    openThemeMenu()
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Light" }))

    expect(themeStore.theme()).toBe("light")
    expect(document.documentElement).toHaveClass("light")
    expect(localStorage.getItem("wisp_theme")).toBe("light")
    expect(screen.getByRole("button", { name: "Theme" })).toHaveTextContent("Light")
  })

  it("reports which theme System landed on", async () => {
    themeStore.set("system")
    render(<SettingsDialog open onOpenChange={() => {}} />)
    openThemeMenu()

    const system = await screen.findByRole("menuitemradio", { name: /System/ })
    expect(system).toHaveAttribute("aria-checked", "true")
    // jsdom implements no matchMedia, so the device reads as dark here; the
    // hint exists to say where System landed, whatever that turns out to be
    expect(system).toHaveTextContent("dark")
  })

  it("closes on Done, because a preference is already applied", () => {
    let open = true
    render(<SettingsDialog open onOpenChange={(next) => { open = next }} />)

    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(open).toBe(false)
  })
})
