import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_THEME_PREFERENCE, themeStore } from "@/lib/theme"
import type { DaemonTransport } from "@/lib/transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SettingsDialog } from "./settings-dialog"

afterEach(() => {
  themeStore.set(DEFAULT_THEME_PREFERENCE)
  localStorage.clear()
})

function renderSettings(request = vi.fn().mockResolvedValue({
  autoRenameTasksFromPullRequests: true,
})) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const transport = fakeDaemonTransport("local", {
    request: request as DaemonTransport["request"],
  })
  return {
    request,
    ...render(<SettingsDialog open onOpenChange={() => {}} />, {
      wrapper: runtimeWrapper(transport, client),
    }),
  }
}

function openThemeMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Theme" }))
}

describe("Wisp settings", () => {
  it("picks light from the appearance section, applies it and remembers it", async () => {
    renderSettings()

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
    renderSettings()
    openThemeMenu()

    const system = await screen.findByRole("menuitemradio", { name: /System/ })
    expect(system).toHaveAttribute("aria-checked", "true")
    // jsdom implements no matchMedia, so the device reads as dark here; the
    // hint exists to say where System landed, whatever that turns out to be
    expect(system).toHaveTextContent("dark")
  })

  it("closes on Done, because a preference is already applied", () => {
    let open = true
    const request = vi.fn().mockResolvedValue({
      autoRenameTasksFromPullRequests: true,
    })
    const client = new QueryClient()
    const transport = fakeDaemonTransport("local", {
      request: request as DaemonTransport["request"],
    })
    render(<SettingsDialog open onOpenChange={(next) => { open = next }} />, {
      wrapper: runtimeWrapper(transport, client),
    })

    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(open).toBe(false)
  })

  it("enables PR-title renaming by default and saves an opt-out", async () => {
    const request = vi.fn().mockImplementation(
      (_path: string, options?: { body?: unknown }) =>
        Promise.resolve(
          options?.body ?? { autoRenameTasksFromPullRequests: true },
        ),
    )
    renderSettings(request)

    const toggle = await screen.findByRole("switch", {
      name: "Use pull request titles",
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/settings", {
        method: "PATCH",
        body: { autoRenameTasksFromPullRequests: false },
      }),
    )
    expect(await screen.findByRole("switch", {
      name: "Use pull request titles",
    })).toHaveAttribute("aria-checked", "false")
  })
})
