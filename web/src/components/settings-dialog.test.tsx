import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    client,
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
    // the switch renders disabled before the settings arrive; enabled means they did
    const toggle = await screen.findByRole("switch", { name: "Use pull request titles" })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(screen.queryByText("Review judge")).not.toBeInTheDocument()
  })
})

describe("the review judge", () => {
  // not key-shaped, so no secret scanner mistakes a fixture for a credential
  const sample = "jev-test-sample-value"
  const usage = { month: "2026-09", calls: 0, errors: 0, inputTokens: 0, costUsd: 0 }
  const off = { configured: false, source: null, hint: null, model: "jev-1.13.0", usage }
  const saved = { configured: true, source: "settings", hint: "…alue", model: "jev-1.13.0", usage: { ...usage, calls: 3, costUsd: 0.00012 } }

  /** A daemon whose judge state a test can also change "from another client". */
  function daemon(initial: object, test: object = { ok: true, ms: 768, model: "jev-1.13.0" }) {
    const state = { judge: initial, refuse: null as string | null }
    const request = vi.fn().mockImplementation((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
      if (path === "/api/settings/review-judge/test") return Promise.resolve(test)
      if (options?.method === "PATCH") {
        if (state.refuse) return Promise.reject(new Error(state.refuse))
        const key = options.body?.jevApiKey
        state.judge = key === null ? off : { ...saved, hint: `…${String(key).slice(-4)}` }
      }
      return Promise.resolve({ autoRenameTasksFromPullRequests: true, reviewJudge: state.judge })
    })
    return { request, state }
  }
  const patches = (request: ReturnType<typeof vi.fn>) =>
    request.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === "PATCH")
  const typeKey = (value: string) => fireEvent.change(screen.getByLabelText("Jev API key"), { target: { value } })

  it("saves a pasted key once and keeps it nowhere in the client", async () => {
    const { request } = daemon(off)
    const { client } = renderSettings(request)

    const field = await screen.findByLabelText("Jev API key")
    expect(field).toHaveAttribute("type", "password")
    // a password manager must neither save it nor fill a saved credential in
    expect(field.closest("form")).toBeNull()
    expect(field).toHaveAttribute("data-1p-ignore")
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    typeKey(`  ${sample}  `)
    expect(screen.getByText(/Not saved yet/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("…alue")).toBeInTheDocument()
    expect(patches(request)).toEqual([["/api/settings", { method: "PATCH", body: { jevApiKey: sample } }]])
    expect(screen.queryByLabelText("Jev API key")).not.toBeInTheDocument()
    expect(screen.getByText("Saved on this daemon.")).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(sample)
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0))
  })

  it("never pre-fills a replacement with the key it replaced", async () => {
    const { request } = daemon(off)
    renderSettings(request)

    await screen.findByLabelText("Jev API key")
    typeKey(sample)
    fireEvent.keyDown(screen.getByLabelText("Jev API key"), { key: "Enter" })
    fireEvent.click(await screen.findByRole("button", { name: "Replace…" }))
    expect(screen.getByLabelText("Jev API key")).toHaveValue("")
    expect(screen.getByLabelText("Jev API key")).toHaveFocus()
  })

  it("tests the key and says how fast it answered", async () => {
    const { request } = daemon(saved)
    renderSettings(request)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The key works: answered in 768 ms."))
    expect(request).toHaveBeenCalledWith("/api/settings/review-judge/test", { method: "POST" })
    expect(screen.getByText(/3 calls this month · under \$0\.01 · jev-1\.13\.0/)).toBeInTheDocument()
  })

  it("says why a test failed", async () => {
    renderSettings(daemon(saved, { ok: false, error: "Jev answered HTTP 401" }).request)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The test failed: Jev answered HTTP 401")
  })

  it("drops a test result once the key it tested changes elsewhere", async () => {
    const { request, state } = daemon(saved)
    const { client } = renderSettings(request)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The key works"))
    state.judge = { ...saved, hint: "…ther" }
    await act(() => client.invalidateQueries())

    expect(await screen.findByText("…ther")).toBeInTheDocument()
    expect(screen.getByRole("status")).toBeEmptyDOMElement()
  })

  it("removes a saved key only once it is confirmed", async () => {
    const { request } = daemon(saved)
    renderSettings(request)

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }))
    expect(screen.getByText("Remove the key?")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Keep" }))
    expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus()
    expect(patches(request)).toHaveLength(0)

    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(patches(request)).toEqual([["/api/settings", { method: "PATCH", body: { jevApiKey: null } }]]))
    expect(await screen.findByLabelText("Jev API key")).toHaveFocus()
  })

  it("replaces a key, and Cancel keeps the one already set", async () => {
    renderSettings(daemon(saved).request)

    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The key works"))
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))
    // the result was about the key being replaced
    expect(screen.getByRole("status")).toBeEmptyDOMElement()
    typeKey("draft-value")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(await screen.findByText("…alue")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace…" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))
    expect(screen.getByLabelText("Jev API key")).toHaveValue("")
  })

  it("cannot remove a key from the daemon's environment, only override it", async () => {
    renderSettings(daemon({ ...saved, source: "environment" }).request)

    expect(await screen.findByText(/From the daemon's environment \(TYPESAFE_API_KEY or JEV_API_KEY\)\. A key saved here takes its place\./)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace…" })).toBeInTheDocument()
  })

  it("says what a key looks like before sending a malformed one", async () => {
    const { request } = daemon(off)
    renderSettings(request)

    await screen.findByLabelText("Jev API key")
    typeKey("has a space")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(screen.getByRole("alert")).toHaveTextContent("A Jev key is 8 to 512 characters with no spaces.")
    expect(screen.getByLabelText("Jev API key")).toHaveAttribute("aria-invalid", "true")
    expect(patches(request)).toHaveLength(0)
  })

  it("shows the daemon's reason when it refuses a key, and keeps the draft", async () => {
    const { request, state } = daemon(off)
    state.refuse = "could not write config.json"
    renderSettings(request)

    await screen.findByLabelText("Jev API key")
    typeKey(sample)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("could not write config.json")
    // the draft stays, so a typo can be fixed rather than pasted again
    expect(screen.getByLabelText("Jev API key")).toHaveValue(sample)
  })

  it("drops a refused draft once a key is set from another client", async () => {
    const { request, state } = daemon(off)
    state.refuse = "could not write config.json"
    const { client } = renderSettings(request)

    await screen.findByLabelText("Jev API key")
    typeKey(sample)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await screen.findByRole("alert")
    state.judge = { ...saved, hint: "…ther" }
    await act(() => client.invalidateQueries())

    expect(await screen.findByText("…ther")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }))
    expect(screen.getByLabelText("Jev API key")).toHaveValue("")
  })
})

describe("the Factory key for droid's limits", () => {
  const sample = "factory-test-sample-value"
  const off = { configured: false, source: null, hint: null }

  function daemon(test: object) {
    const state = { key: off as object }
    const request = vi.fn().mockImplementation((path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
      if (path === "/api/settings/factory-key/test") return Promise.resolve(test)
      if (options?.method === "PATCH") {
        const key = options.body?.factoryApiKey
        state.key = key === null ? off : { configured: true, source: "settings", hint: `…${String(key).slice(-4)}` }
      }
      return Promise.resolve({ autoRenameTasksFromPullRequests: true, usageLimits: { factoryKey: state.key } })
    })
    return request
  }

  it("saves the key through its own field, apart from the Jev key", async () => {
    const request = daemon({ ok: true, ms: 212, account: "verified" })
    renderSettings(request)

    expect(await screen.findByText("Usage limits")).toBeInTheDocument()
    expect(screen.queryByText("Review judge")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Factory API key"), { target: { value: sample } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("…alue")).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith("/api/settings", { method: "PATCH", body: { factoryApiKey: sample } })
    expect(document.body.innerHTML).not.toContain(sample)

    fireEvent.click(screen.getByRole("button", { name: "Test" }))
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "The key works: droid's limits answered in 212 ms, for the account droid is logged in to.",
      ),
    )
  })

  it("says when the key is for a different account", async () => {
    const request = daemon({
      ok: false,
      status: "account-mismatch",
      error: "This Factory API key belongs to a different account than the one droid is logged in to.",
    })
    renderSettings(request)

    fireEvent.change(await screen.findByLabelText("Factory API key"), { target: { value: sample } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    fireEvent.click(await screen.findByRole("button", { name: "Test" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The test failed: This Factory API key belongs to a different account")
  })
})
