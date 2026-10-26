import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DesktopConnectionChrome } from "./connection-chrome"
import type {
  DesktopBootstrap,
  DesktopBridge,
  DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import {
  DesktopApplicationProvider,
  useDesktopConnections,
} from "@/lib/desktop-connections"
import { validateConnectionName } from "@/lib/connection-validation"
import {
  clearConnectionDrafts,
  createTaskScope,
  writeCreateTaskDraft,
  writeDraft,
  writePendingAttachmentCount,
} from "@/lib/drafts"
import { connectionStore } from "@/lib/conn"

const LOCAL = {
  id: "local",
  routeRevision: 0,
  kind: "local",
  name: "Local",
  url: null,
  instanceId: "wisp-instance-local",
  ready: true,
} as const

const REMOTE = {
  id: "remote-one",
  kind: "remote",
  name: "Remote one",
  url: "https://remote.example.test",
  instanceId: "wisp-instance-remote-one",
  ready: true,
} as const

const REPLACEMENT_RECONNECT = {
  connectionId: "remote-one",
  url: "https://replacement.example.test",
  token: "synthetic-replacement-token",
  expectedInstanceId: "wisp-instance-remote-one",
}

function bootstrap(
  connections: DesktopBootstrap["connections"] = [LOCAL]
): DesktopBootstrap {
  return {
    connections,
    activeConnectionId: "local",
    proxyBaseUrl: "http://127.0.0.1:45123/per-launch-capability",
    local: {
      available: true,
      configPath: "/synthetic/.wisp/config.json",
      baseUrl: "http://127.0.0.1:18710",
      instanceId: "wisp-instance-local",
      hasToken: true,
      reason: null,
    },
  }
}

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    bootstrap: async () => bootstrap(),
    selectConnection: async () => undefined,
    probeRemoteConnection: async () => ({
      instanceId: "wisp-instance-remote-one",
      apiProtocolVersion: 1,
      version: "0.4.0-synthetic",
    }),
    probeSavedConnection: async () => ({
      instanceId: "wisp-instance-remote-one",
      apiProtocolVersion: 1,
      version: "0.4.0-synthetic",
    }),
    addRemoteConnection: async () => LOCAL,
    renameConnection: async () => LOCAL,
    reconnectConnection: async () => LOCAL,
    removeConnection: async () => undefined,
    resetDesktopData: async () => undefined,
    saveTaskExport: async () => true,
    saveOutputImage: async () => true,
    pickLocalProject: async () => null,
    setupLocalWisp: async () => ({
      status: bootstrap().local,
      cliPath: "/synthetic/bin/wisp",
      daemonReachable: true,
      nextStep: "ready",
      message: "Local Wisp is ready.",
    }),
    notifyTaskTransition: async () => undefined,
    onFocusTask: async () => () => undefined,
    applyLocalWispSetup: async () => ({
      status: bootstrap().local,
      cliPath: "/synthetic/bin/wisp",
      daemonReachable: true,
      nextStep: "ready",
      message: "Local Wisp is ready.",
    }),
    openExternalUrl: async () => undefined,
    desktopUpdateStatus: async () => ({
      channel: "alpha",
      configured: false,
      currentVersion: "0.4.0-synthetic",
      latestVersion: null,
      phase: "unconfigured",
      releaseNotes: null,
      publishedAt: null,
      checkedAt: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: "Updater is not configured.",
    }),
    checkDesktopUpdate: async () => {
      throw new Error("Updater is not configured.")
    },
    installDesktopUpdate: async () => {
      throw new Error("Updater is not configured.")
    },
    relaunchDesktop: async () => undefined,
    onDesktopUpdateStatus: async () => () => undefined,
    revealWorktreeFile: async () => undefined,
    ...overrides,
  }
}

function renderChrome(
  initial: DesktopBootstrap,
  nativeBridge: DesktopBridge,
  mobile = false
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DesktopApplicationProvider initial={initial} bridge={nativeBridge}>
        <DesktopConnectionChrome mobile={mobile} />
      </DesktopApplicationProvider>
    </QueryClientProvider>
  )
}

/** The top bar's picker: its name leads with the current connection. */
function picker(name: string | RegExp = /^Connection: /) {
  return screen.getByRole("button", { name, hidden: true })
}

async function openPicker() {
  fireEvent.click(picker())
  return screen.findByRole("menu")
}

/** Switch through the picker's menu, as a person does. */
async function choose(name: string) {
  await openPicker()
  fireEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }))
}

/** One of the menu's verbs, on the current connection or the app. */
async function verb(name: string) {
  await openPicker()
  fireEvent.click(await screen.findByRole("menuitem", { name }))
}

function seedCreateDraft(connectionId: string) {
  writeCreateTaskDraft(connectionId, "/repo", {
    prompt: "new work",
    choice: { harness: "droid", model: "synthetic-model" },
    effort: "",
    fast: false,
    mode: "worktree",
    base: "",
    suffixPromptId: null,
    autopilot: { autoMerge: false, autoFix: false },
  })
  writePendingAttachmentCount(connectionId, createTaskScope("/repo"), 1)
}

function PartialReconnectHarness() {
  const desktop = useDesktopConnections()!
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void desktop
            .reconnect({
              connectionId: "remote-one",
              url: "https://replacement.example.test",
              expectedInstanceId: "wisp-instance-remote-two",
            })
            .catch(() => undefined)
        }}
      >
        Reconnect now
      </button>
      <output aria-label="active connection">{desktop.active.metadata.id}</output>
      {desktop.actionError ? <p role="alert">{desktop.actionError}</p> : null}
    </>
  )
}

function ReachabilityControls() {
  const desktop = useDesktopConnections()!
  return (
    <>
      <button type="button" onClick={() => desktop.reportReachability(LOCAL.id, "online")}>
        Local online
      </button>
      <button type="button" onClick={() => desktop.reportReachability(REMOTE.id, "online")}>
        Remote online
      </button>
      <button type="button" onClick={() => desktop.reportReachability(REMOTE.id, "offline")}>
        Remote offline
      </button>
    </>
  )
}

async function changedRemoteUrlNeedsToken() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
  const remote = {
    id: "remote-one",
    kind: "remote",
    name: "Remote one",
    url: "https://remote.example.test",
    instanceId: "wisp-instance-remote-one",
    ready: true,
  } as const
  const probeSavedConnection = vi.fn(async () => ({
    instanceId: "wisp-instance-remote-two",
    apiProtocolVersion: 1,
    version: "0.4.0-synthetic",
  }))
  renderChrome(bootstrap([LOCAL, remote]), bridge({ probeSavedConnection }))

  await choose("Remote one")
  await verb("Edit connection")
  fireEvent.change(screen.getByLabelText("Daemon URL"), {
    target: { value: "https://replacement.example.test" },
  })
  expect(screen.getByLabelText("New token")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "new token is required"
  )
  expect(probeSavedConnection).not.toHaveBeenCalled()

  fireEvent.change(screen.getByLabelText("New token"), {
    target: { value: "synthetic-replacement-token" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
  await waitFor(() =>
    expect(probeSavedConnection).toHaveBeenCalledWith({
      connectionId: remote.id,
      url: "https://replacement.example.test",
      token: "synthetic-replacement-token",
    })
  )
}

afterEach(() => {
  // unmount first: a monitor torn down after the reset below would leave its
  // stream "opening" for the next test
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearConnectionDrafts("local")
  clearConnectionDrafts("remote-one")
  for (const id of [LOCAL.id, REMOTE.id]) {
    connectionStore(id).set("events", true)
    connectionStore(id).set("log", true)
  }
})

describe("desktop connection chrome", () => {
  it("rejects hostname HTTP, invokes native with normalized input, and clears the token immediately", async () => {
    let finish!: () => void
    const addRemoteConnection = vi.fn(
      () =>
        new Promise<DesktopConnectionMetadata>((resolve) => {
          finish = () =>
            resolve({
              id: "remote-one",
              kind: "remote",
              name: "Remote one",
              url: "https://remote.example.test",
              instanceId: "wisp-instance-remote-one",
              ready: true,
            })
        })
    )
    renderChrome(bootstrap(), bridge({ addRemoteConnection }))

    await verb("Add connection")
    fireEvent.change(screen.getByLabelText("Connection name"), {
      target: { value: "Remote one" },
    })
    fireEvent.change(screen.getByLabelText("Daemon URL"), {
      target: { value: "http://localhost:8811" },
    })
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "synthetic-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "exact loopback address"
    )
    expect(addRemoteConnection).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Token")).toHaveValue("synthetic-token")

    fireEvent.change(screen.getByLabelText("Daemon URL"), {
      target: { value: "https://remote.example.test/" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
    expect(
      await screen.findByText("Reached Wisp 0.4.0-synthetic")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toHaveValue("synthetic-token")
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }))
    await waitFor(() =>
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: "Remote one",
        url: "https://remote.example.test",
        token: "synthetic-token",
        expectedInstanceId: "wisp-instance-remote-one",
      })
    )
    expect(screen.getByLabelText("Token")).toHaveValue("")
    finish()
  })

  it("forgets a remote token when the dialog is cancelled", async () => {
    renderChrome(bootstrap(), bridge())
    await verb("Add connection")
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "synthetic-token-to-forget" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await verb("Add connection")
    expect(screen.getByLabelText("Token")).toHaveValue("")
  })

  it("never offers removal for the built-in local connection", async () => {
    renderChrome(bootstrap(), bridge())

    await openPicker()
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Diagnose local Wisp" })).toBeInTheDocument()
    expect(screen.queryByText("Remove connection")).toBeNull()
  })

  it("diagnoses Local before asking consent for the exact native repair", async () => {
    const setupLocalWisp = vi.fn(async () => ({
      status: {
        ...bootstrap().local,
        available: false,
        baseUrl: null,
        instanceId: null,
        hasToken: false,
        reason: "no profile",
      },
      cliPath: "/synthetic/bin/wisp",
      daemonReachable: false,
      nextStep: "run-init" as const,
      message: "Wisp is installed but has no profile yet.",
    }))
    const applyLocalWispSetup = vi.fn(bridge().applyLocalWispSetup)
    renderChrome(
      bootstrap(),
      bridge({ setupLocalWisp, applyLocalWispSetup })
    )

    await verb("Diagnose local Wisp")
    expect(
      await screen.findByText("Wisp is installed but has no profile yet.")
    ).toBeInTheDocument()
    expect(applyLocalWispSetup).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole("button", { name: "Initialize and start Wisp" })
    )
    await waitFor(() =>
      expect(applyLocalWispSetup).toHaveBeenCalledWith("run-init")
    )
  })

  it("explains that removing a remote leaves daemon work running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]"))
    )
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    renderChrome(bootstrap([LOCAL, remote]), bridge())

    await choose("Remote one")
    await verb("Remove connection")

    expect(
      await screen.findByText(/Tasks and data on the daemon keep running/)
    ).toBeInTheDocument()
    expect(screen.getByText(/stored credential/)).toBeInTheDocument()
  })

  it("counts create drafts and pending files in the remote removal warning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    const removeConnection = vi.fn(async () => undefined)
    writeDraft(remote.id, "synthetic-task", "unsent work")
    seedCreateDraft(remote.id)
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({ removeConnection })
    )

    await choose("Remote one")
    await verb("Remove connection")
    expect(await screen.findByText(/2 unsent drafts and 1 pending attachment/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Review local data" }))
    expect(removeConnection).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Discard data and remove" })
    )
    await waitFor(() => expect(removeConnection).toHaveBeenCalledWith(remote.id))
  })

  it("keeps a native removal failure visible after switching away", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({
        removeConnection: async () => {
          throw new Error("synthetic Keychain cleanup failed")
        },
      })
    )

    await choose("Remote one")
    await verb("Remove connection")
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }))

    expect(await screen.findByText("Connection action failed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "synthetic Keychain cleanup failed"
    )
  })

  it("shows a deferred launch cleanup issue without hiding healthy connections", async () => {
    renderChrome(
      {
        ...bootstrap(),
        cleanupIssues: [
          {
            connectionId: "remote-removed",
            message: "Credential cleanup is incomplete; retry reset.",
          },
        ],
      },
      bridge()
    )
    expect(await screen.findByText("Connection action failed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Credential cleanup is incomplete"
    )
    expect(picker(/^Connection: Local/)).toBeInTheDocument()
  })

  it("keeps a partial reset cleanup failure in provider-owned UI", async () => {
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    let resetStarted = false
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({
        resetDesktopData: async () => {
          resetStarted = true
          throw new Error("synthetic deferred reset cleanup")
        },
        bootstrap: async () =>
          resetStarted ? bootstrap([LOCAL]) : bootstrap([LOCAL, remote]),
      })
    )
    await choose("Remote one")
    await verb("Reset desktop data")
    fireEvent.click(screen.getByRole("button", { name: "Reset desktop data" }))

    expect(await screen.findByText("Connection action failed")).toBeInTheDocument()
    expect(screen.getAllByRole("alert").some((alert) =>
      alert.textContent?.includes("synthetic deferred reset cleanup")
    )).toBe(true)
    expect(picker(/^Connection: Local/)).toBeInTheDocument()
  })

  it("adopts a committed replacement when reconnect cleanup reports failure", async () => {
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    const replacement = {
      ...remote,
      id: "remote-two",
      url: "https://replacement.example.test",
      instanceId: "wisp-instance-remote-two",
    } as const
    let committed = false
    const selectConnection = vi.fn(async () => undefined)
    const nativeBridge = bridge({
      selectConnection,
      reconnectConnection: async () => {
        committed = true
        throw new Error("synthetic old credential cleanup failed")
      },
      bootstrap: async () =>
        committed
          ? bootstrap([LOCAL, replacement])
          : bootstrap([LOCAL, remote]),
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider
          initial={{
            ...bootstrap([LOCAL, remote]),
            activeConnectionId: remote.id,
          }}
          bridge={nativeBridge}
        >
          <PartialReconnectHarness />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))

    await waitFor(() =>
      expect(screen.getByLabelText("active connection")).toHaveTextContent(
        replacement.id
      )
    )
    expect(selectConnection).toHaveBeenCalledWith(replacement.id)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "synthetic old credential cleanup failed"
    )
  })

  it("resets desktop-owned state without claiming to remove daemon data", async () => {
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    const resetDesktopData = vi.fn(async () => undefined)
    localStorage.setItem("synthetic-desktop-preference", "present")
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({ resetDesktopData })
    )

    await verb("Reset desktop data")
    expect(screen.getByText(/daemons keep running/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reset desktop data" }))

    await waitFor(() => expect(resetDesktopData).toHaveBeenCalledOnce())
    expect(localStorage.getItem("synthetic-desktop-preference")).toBeNull()
  })

  it("warns before a URL edit discards connection-local work", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    const reconnectConnection = vi.fn(async () => remote)
    writeDraft(remote.id, "synthetic-task", "unsent work")
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({ reconnectConnection })
    )

    await choose("Remote one")
    await verb("Edit connection")
    fireEvent.change(screen.getByLabelText("Daemon URL"), {
      target: { value: "https://replacement.example.test" },
    })
    fireEvent.change(screen.getByLabelText("New token"), {
      target: { value: "synthetic-replacement-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }))
    await screen.findByText("Reached Wisp 0.4.0-synthetic")
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Changing which daemon this connection trusts will discard 1 unsent draft"
    )
    expect(reconnectConnection).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reconnect and discard local data",
      })
    )
    await waitFor(() => expect(reconnectConnection).toHaveBeenCalledWith(REPLACEMENT_RECONNECT))
  })

  it("requires a new token before probing a changed remote URL", changedRemoteUrlNeedsToken)

  it("requires explicit trust when reconnect reaches a different daemon", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const remote = {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://remote.example.test",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    } as const
    const reconnectConnection = vi.fn(async () => ({
      ...remote,
      id: "remote-two",
      instanceId: "wisp-instance-remote-two",
    }))
    writeDraft(remote.id, "synthetic-task", "unsent work")
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({
        probeSavedConnection: async () => ({
          instanceId: "wisp-instance-remote-two",
          apiProtocolVersion: 1,
          version: "0.4.0-synthetic",
        }),
        reconnectConnection,
      })
    )

    await choose("Remote one")
    await verb("Edit connection")
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }))

    expect(await screen.findByText(/different daemon/i)).toBeInTheDocument()
    expect(screen.getByText(/Saved: wisp-instance-remote-one/)).toBeInTheDocument()
    expect(reconnectConnection).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Trust new daemon and reconnect",
      })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Changing which daemon this connection trusts will discard 1 unsent draft"
    )
    expect(reconnectConnection).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reconnect and discard local data",
      })
    )
    await waitFor(() =>
      expect(reconnectConnection).toHaveBeenCalledWith({
        connectionId: remote.id,
        url: remote.url,
        expectedInstanceId: "wisp-instance-remote-two",
      })
    )
  })

  it("uses a connection menu instead of horizontal tabs on mobile", () => {
    renderChrome(bootstrap(), bridge(), true)

    expect(screen.getByRole("button", { name: "Local" })).toBeInTheDocument()
    expect(screen.queryByRole("tablist")).toBeNull()
  })

  it("retries a remote from the touch shell's ⋯, as the picker does, without the Edit dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const reconnectConnection = vi.fn(async () => REMOTE)
    renderChrome(bootstrap([LOCAL, REMOTE]), bridge({ reconnectConnection }), true)

    fireEvent.click(screen.getByRole("button", { name: "Local" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Remote one/ }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }))
    await waitFor(() =>
      expect(reconnectConnection).toHaveBeenCalledWith({ connectionId: REMOTE.id })
    )
    expect(screen.queryByLabelText("Daemon URL")).toBeNull()
  })

  it("disables Add after eight total connections", async () => {
    class EventSourceStub {
      onopen: (() => void) | null = null
      onmessage: (() => void) | null = null
      close(): void {}
    }
    vi.stubGlobal("EventSource", EventSourceStub)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]"))
    )
    const connections: DesktopBootstrap["connections"] = [
      LOCAL,
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `remote-${index + 1}`,
        kind: "remote" as const,
        name: `Remote ${index + 1}`,
        url: `https://remote-${index + 1}.example.test`,
        instanceId: `wisp-instance-${index + 1}`,
        ready: true,
      })),
    ]

    renderChrome(bootstrap(connections), bridge())

    await openPicker()
    expect(
      screen.getByRole("menuitem", { name: "At most 8 connections" })
    ).toHaveAttribute("aria-disabled", "true")
  })
})

/**
 * The tabs grew the top bar's left end with every connection and pushed its
 * divider past the sidebar's edge (#441); one picker keeps it the sidebar's width.
 */
describe("the connection picker in the top bar's left end", () => {
  it("is one control whatever the number of connections", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    renderChrome(bootstrap([LOCAL, REMOTE]), bridge())

    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Manage / })).toBeNull()
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull()
    expect(screen.getAllByRole("button")).toEqual([picker(/^Connection: Local$/)])
    // a control, never the window's drag handle; a long name gives way, not the bar
    expect(picker()).not.toHaveAttribute("data-tauri-drag-region")
    expect(picker().parentElement).not.toHaveAttribute("data-tauri-drag-region")
    expect(within(picker()).getByText("Local")).toHaveClass("truncate")

    await openPicker()
    expect(screen.getByRole("menuitemradio", { name: /^Local/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("menuitemradio", { name: /^Remote one/ })).toHaveAttribute("aria-checked", "false")
  })

  it("switches from its menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const selectConnection = vi.fn(async () => undefined)
    renderChrome(bootstrap([LOCAL, REMOTE]), bridge({ selectConnection }))

    await choose("Remote one")
    await waitFor(() => expect(selectConnection).toHaveBeenCalledWith(REMOTE.id))
    expect(picker(/^Connection: Remote one$/)).toBeInTheDocument()
  })

  it("steps through the connections with ←/→, Home and End, as the tabs did", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const third = { ...REMOTE, id: "remote-two", name: "Remote two", instanceId: "wisp-instance-remote-two" }
    const selectConnection = vi.fn(async () => undefined)
    renderChrome(bootstrap([LOCAL, REMOTE, third]), bridge({ selectConnection }))

    fireEvent.keyDown(picker(), { key: "ArrowRight" })
    expect(picker(/^Connection: Remote one$/)).toBeInTheDocument()
    fireEvent.keyDown(picker(), { key: "End" })
    expect(picker(/^Connection: Remote two$/)).toBeInTheDocument()
    fireEvent.keyDown(picker(), { key: "ArrowRight" })
    expect(picker(/^Connection: Local$/)).toBeInTheDocument()
    fireEvent.keyDown(picker(), { key: "ArrowLeft" })
    expect(picker(/^Connection: Remote two$/)).toBeInTheDocument()
    fireEvent.keyDown(picker(), { key: "Home" })
    expect(picker(/^Connection: Local$/)).toBeInTheDocument()
    await waitFor(() => expect(selectConnection).toHaveBeenCalledTimes(5))
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("leaves the arrow keys to the open menu: they never switch from inside it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const selectConnection = vi.fn(async () => undefined)
    renderChrome(bootstrap([LOCAL, REMOTE]), bridge({ selectConnection }))

    await openPicker()
    for (const item of [
      screen.getByRole("menuitemradio", { name: /^Local/ }),
      screen.getByRole("menuitem", { name: "Rename" }),
    ]) {
      for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) fireEvent.keyDown(item, { key })
    }
    expect(selectConnection).not.toHaveBeenCalled()
    expect(picker(/^Connection: Local$/)).toBeInTheDocument()
  })

  it("acts on whichever connection is current", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    renderChrome(bootstrap([LOCAL, REMOTE]), bridge())

    await openPicker()
    expect(screen.getByRole("group", { name: "Local" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Diagnose local Wisp" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Remove connection" })).toBeNull()
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Remote one/ }))

    await openPicker()
    expect(screen.getByRole("group", { name: "Remote one" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Edit connection" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Remove connection" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Diagnose local Wisp" })).toBeNull()
  })
})

/** The picker's mark is the current connection's; every other one shows in the menu. */
function pickerMark(): Element {
  return picker().querySelector("[data-connection-mark]")!
}

/** A row's mark in the open menu, read synchronously like the picker's. */
function rowMark(name: string): Element {
  const row = screen.getByRole("menuitemradio", { name: new RegExp(`^${name}`), hidden: true })
  return row.querySelector("[data-connection-mark]")!
}

/** Opened in the same act as the click, so no fetch settles in between. */
function openPickerNow() {
  fireEvent.click(picker())
  expect(screen.getByRole("menu", { hidden: true })).toBeInTheDocument()
}

/** The test's own reachability switches, which the open menu marks inert. */
function control(name: string) {
  return screen.getByRole("button", { name, hidden: true })
}

describe("connection status", () => {
  it("shows only a green dot for a reachable connection with healthy streams", async () => {
    class EventSourceStub {
      static instances: EventSourceStub[] = []
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: (() => void) | null = null
      constructor() { EventSourceStub.instances.push(this) }
      close(): void {}
    }
    vi.stubGlobal("EventSource", EventSourceStub)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider initial={bootstrap([LOCAL, REMOTE])} bridge={bridge()}>
          <DesktopConnectionChrome />
          <ReachabilityControls />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    expect(pickerMark().querySelector("[data-live]")).toHaveAttribute("data-live", "false")
    openPickerNow()
    fireEvent.click(control("Local online"))
    fireEvent.click(control("Remote online"))
    expect(pickerMark()).toHaveAttribute("title", "Live")
    expect(rowMark("Remote one")).not.toHaveAttribute("title", "Live")
    act(() => EventSourceStub.instances[0]!.onopen?.())
    expect(pickerMark()).toHaveAttribute("title", "Live")
    expect(rowMark("Remote one")).toHaveAttribute("title", "Live")
    expect(pickerMark().querySelector("[data-live]")).toHaveClass("bg-state-done")
    expect((rowMark("Remote one")).querySelector("[data-live]")).toHaveClass("bg-state-done")
    expect(rowMark("Remote one")).not.toHaveAttribute("data-offline")

    connectionStore(LOCAL.id).set("log", false)
    await waitFor(() =>
      expect(pickerMark()).toHaveAttribute("title", "Server reachable · Live updates disconnected")
    )
    expect(pickerMark().querySelector("[data-live]")).toHaveClass("border-muted-foreground", "bg-transparent")
    // The inactive remote does not inherit the selected connection's stream loss.
    expect(rowMark("Remote one")).toHaveAttribute("title", "Live")
    act(() => EventSourceStub.instances[0]!.onerror?.())
    await waitFor(() => expect(rowMark("Remote one")).not.toHaveAttribute("title", "Live"))
    expect((rowMark("Remote one")).querySelector("[data-live]")).toHaveAttribute("data-live", "false")
    act(() => EventSourceStub.instances[0]!.onopen?.())
    expect(rowMark("Remote one")).toHaveAttribute("title", "Live")
    fireEvent.click(control("Remote offline"))
    expect(rowMark("Remote one")).toHaveAttribute("title", "Daemon unavailable")
    expect((rowMark("Remote one")).querySelector("[data-live]")).toBeNull()
    expect(rowMark("Remote one")).toHaveClass("text-destructive")
  })

  it("shows a down connection as one red cloud, on the picker and in the menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider initial={bootstrap([LOCAL, REMOTE])} bridge={bridge()}>
          <DesktopConnectionChrome />
          <ReachabilityControls />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    openPickerNow()
    fireEvent.click(control("Remote offline"))

    // a red dot beside a red cloud said "unreachable" twice; the cloud alone says it
    const row = rowMark("Remote one").closest("[role=menuitemradio]")!
    expect(row.querySelectorAll("[data-live]")).toHaveLength(0)
    expect(row.querySelectorAll("[data-offline]")).toHaveLength(1)
    expect(row).toHaveTextContent("Daemon unavailable")

    fireEvent.click(row)
    expect(picker(/^Connection: Remote one, Daemon unavailable$/)).toBeInTheDocument()
    expect(pickerMark()).toHaveAttribute("data-offline")
  })

  it("keeps task state off the marks: the one mark is connection health", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([{ id: "t1", state: "needs-input", archived: false }]))
    ))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider initial={bootstrap([LOCAL, REMOTE])} bridge={bridge()}>
          <DesktopConnectionChrome />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await openPicker()
    const row = rowMark("Remote one").closest("[role=menuitemradio]")!
    expect(row.querySelectorAll("[data-state]")).toHaveLength(0)
    expect(row.querySelectorAll("[data-live]")).toHaveLength(1)
    expect(picker().querySelectorAll("[data-state]")).toHaveLength(0)
  })

  it("keeps both connections green during a stream handoff, then warns if updates stall", async () => {
    class EventSourceStub {
      static instances: EventSourceStub[] = []
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: (() => void) | null = null
      readonly url: string
      constructor(url: string) {
        this.url = url
        EventSourceStub.instances.push(this)
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", EventSourceStub)
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider initial={bootstrap([LOCAL, REMOTE])} bridge={bridge()}>
          <DesktopConnectionChrome />
          <ReachabilityControls />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    openPickerNow()
    fireEvent.click(control("Local online"))
    fireEvent.click(control("Remote online"))
    act(() => EventSourceStub.instances[0]!.onopen?.())
    expect(pickerMark()).toHaveAttribute("title", "Live")
    expect(rowMark("Remote one")).toHaveAttribute("title", "Live")

    vi.useFakeTimers()
    fireEvent.click(rowMark("Remote one").closest("[role=menuitemradio]")!)
    openPickerNow()
    const handoff = "Server reachable · Connecting live updates…"
    for (const mark of [pickerMark(), rowMark("Local")]) {
      expect(mark).toHaveAttribute("title", handoff)
      expect(mark.querySelector("[data-live]")).toHaveClass("bg-state-done")
      expect(mark.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull()
    }
    expect(EventSourceStub.instances).toHaveLength(2)
    expect(EventSourceStub.instances[1]!.url).toContain("/connections/local/")

    act(() => vi.advanceTimersByTime(3_000))
    expect(rowMark("Local")).toHaveAttribute("title", "Server reachable · Live updates delayed")
    expect(rowMark("Local").querySelector("[data-live]")).toHaveClass("border-muted-foreground", "bg-transparent")
    act(() => EventSourceStub.instances[1]!.onopen?.())
    expect(rowMark("Local")).toHaveAttribute("title", "Live")
    act(() => connectionStore(REMOTE.id).set("events", true))
    expect(pickerMark()).toHaveAttribute("title", "Live")
  })

  it("does not disguise a failed stream as a normal handoff", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider initial={bootstrap([LOCAL, REMOTE])} bridge={bridge()}>
          <DesktopConnectionChrome />
          <ReachabilityControls />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    openPickerNow()
    fireEvent.click(control("Remote online"))
    act(() => connectionStore(REMOTE.id).set("events", false))
    const disconnected = "Server reachable · Live updates disconnected"
    expect(rowMark("Remote one")).toHaveAttribute("title", disconnected)
    fireEvent.click(rowMark("Remote one").closest("[role=menuitemradio]")!)
    expect(pickerMark()).toHaveAttribute("title", disconnected)
  })

  it("reconnects a down connection without selecting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")))
    const reconnectConnection = vi.fn(async (input: { connectionId: string }) =>
      input.connectionId === LOCAL.id ? LOCAL : REMOTE
    )
    const selectConnection = vi.fn(async () => undefined)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider
          initial={bootstrap([LOCAL, REMOTE])}
          bridge={bridge({ reconnectConnection, selectConnection })}
        >
          <DesktopConnectionChrome />
          <ReachabilityControls />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )
    // a healthy connection you are not on has nothing to retry
    await openPicker()
    expect(screen.queryByRole("menuitem", { name: "Reconnect Remote one" })).toBeNull()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Remote offline", hidden: true }))

    await verb("Reconnect Remote one")
    await waitFor(() =>
      expect(reconnectConnection).toHaveBeenCalledWith({ connectionId: REMOTE.id })
    )
    expect(selectConnection).not.toHaveBeenCalled()
    expect(picker(/^Connection: Local$/)).toBeInTheDocument()

    await verb("Reconnect")
    await waitFor(() =>
      expect(reconnectConnection).toHaveBeenCalledWith({ connectionId: LOCAL.id })
    )
  })

  it("reports reconnect failures and blocks repeated reconnects while reconnecting", async () => {
    let fail!: (error: Error) => void
    const reconnectConnection = vi.fn(
      () => new Promise<DesktopConnectionMetadata>((_, reject) => { fail = reject })
    )
    renderChrome(bootstrap(), bridge({ reconnectConnection }))
    await verb("Reconnect")
    await openPicker()
    expect(screen.getByRole("menuitem", { name: "Reconnect" })).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("menuitem", { name: "Reconnect" }))
    expect(reconnectConnection).toHaveBeenCalledOnce()
    fail(new Error("synthetic daemon unavailable"))
    expect(await screen.findByRole("alert")).toHaveTextContent("synthetic daemon unavailable")
  })
})

describe("connection names", () => {
  it("treats whitespace and case variants as duplicates", () => {
    const connections = [{ metadata: LOCAL }]
    expect(validateConnectionName("  local  ", connections)).toBe(
      "Connection names must be unique"
    )
    expect(validateConnectionName("Laptop", connections)).toBeNull()
  })
})
