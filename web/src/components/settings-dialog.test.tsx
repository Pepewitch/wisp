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

  it("hides the review judge on a daemon that has none", async () => {
    renderSettings()
    await screen.findByRole("switch", { name: "Use pull request titles" })
    expect(screen.queryByText("Review judge")).not.toBeInTheDocument()
  })
})

describe("the review judge", () => {
  // not key-shaped, so no secret scanner mistakes a fixture for a credential
  const sample = "jev-test-sample-value"
  const usage = { month: "2026-09", calls: 0, errors: 0, inputTokens: 0, costUsd: 0 }
  const off = { configured: false, source: null, hint: null, model: "jev-1.13.0", usage }
  const saved = { configured: true, source: "settings", hint: "…alue", model: "jev-1.13.0", usage: { ...usage, calls: 3, costUsd: 0.00012 } }

  function daemon(initial: object, test: object = { ok: true, ms: 768, model: "jev-1.13.0" }) {
    let judge = initial
    return vi.fn().mockImplementation((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
      if (path === "/api/settings/review-judge/test") return Promise.resolve(test)
      if (options?.method === "PATCH") {
        const key = options.body?.jevApiKey
        judge = key === null ? off : { ...saved, hint: `…${String(key).slice(-4)}` }
      }
      return Promise.resolve({ autoRenameTasksFromPullRequests: true, reviewJudge: judge })
    })
  }

  it("saves a pasted key once, clears the field, and shows only its last four characters", async () => {
    const request = daemon(off)
    renderSettings(request)

    const field = await screen.findByLabelText("Jev API key")
    expect(field).toHaveAttribute("type", "password")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.change(field, { target: { value: `  ${sample}  ` } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/settings", { method: "PATCH", body: { jevApiKey: sample } }),
    )
    expect(await screen.findByText("…alue")).toBeInTheDocument()
    expect(screen.queryByLabelText("Jev API key")).not.toBeInTheDocument()
    expect(screen.getByText("Saved on this daemon.")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(sample)
  })

  it("tests the key and says how fast it answered", async () => {
    const request = daemon(saved)
    renderSettings(request)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    expect(await screen.findByRole("status")).toHaveTextContent("The key works: answered in 768 ms.")
    expect(request).toHaveBeenCalledWith("/api/settings/review-judge/test", { method: "POST" })
    expect(screen.getByText(/3 calls this month · under \$0\.01 · jev-1\.13\.0/)).toBeInTheDocument()
  })

  it("says why a test failed", async () => {
    renderSettings(daemon(saved, { ok: false, error: "Jev answered 401" }))

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The test failed: Jev answered 401")
  })

  it("removes a saved key", async () => {
    const request = daemon(saved)
    renderSettings(request)

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/settings", { method: "PATCH", body: { jevApiKey: null } }),
    )
    expect(await screen.findByLabelText("Jev API key")).toBeInTheDocument()
  })

  it("replaces a key, and Cancel keeps the one already set", async () => {
    renderSettings(daemon(saved))

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    await screen.findByRole("status")
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))
    // the result was about the key being replaced
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Jev API key"), { target: { value: "draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(await screen.findByText("…alue")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))
    expect(screen.getByLabelText("Jev API key")).toHaveValue("")
  })

  it("cannot remove a key from the daemon's environment, only override it", async () => {
    renderSettings(daemon({ ...saved, source: "environment" }))

    expect(await screen.findByText("From the daemon's environment. A key saved here takes its place.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace…" })).toBeInTheDocument()
  })

  it("shows the daemon's reason when it refuses a key", async () => {
    const request = daemon(off)
    request.mockImplementation((_path: string, options?: { method?: string }) =>
      options?.method === "PATCH"
        ? Promise.reject(new Error("jevApiKey must be 8–512 printable characters with no spaces"))
        : Promise.resolve({ autoRenameTasksFromPullRequests: true, reviewJudge: off }),
    )
    renderSettings(request)

    fireEvent.change(await screen.findByLabelText("Jev API key"), { target: { value: "short" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("jevApiKey must be 8–512 printable characters")
    // the draft stays, so a typo can be fixed rather than pasted again
    expect(screen.getByLabelText("Jev API key")).toHaveValue("short")
  })
})
