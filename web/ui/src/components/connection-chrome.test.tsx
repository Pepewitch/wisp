import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
import { clearConnectionDrafts, writeDraft } from "@/lib/drafts"

const LOCAL = {
  id: "local",
  routeRevision: 0,
  kind: "local",
  name: "Local",
  url: null,
  instanceId: "wisp-instance-local",
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

  fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
  fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
  fireEvent.click(await screen.findByText("Edit connection"))
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
  vi.unstubAllGlobals()
  clearConnectionDrafts("local")
  clearConnectionDrafts("remote-one")
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

    fireEvent.click(
      screen.getByRole("button", { name: "Add remote connection" })
    )
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

  it("forgets a remote token when the dialog is cancelled", () => {
    renderChrome(bootstrap(), bridge())
    fireEvent.click(
      screen.getByRole("button", { name: "Add remote connection" })
    )
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "synthetic-token-to-forget" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Add remote connection" })
    )
    expect(screen.getByLabelText("Token")).toHaveValue("")
  })

  it("never offers removal for the built-in local connection", async () => {
    renderChrome(bootstrap(), bridge())

    fireEvent.click(screen.getByRole("button", { name: "Manage Local" }))
    expect(await screen.findByText("Rename")).toBeInTheDocument()
    expect(screen.getByText("Diagnose local Wisp")).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole("button", { name: "Manage Local" }))
    fireEvent.click(await screen.findByText("Diagnose local Wisp"))
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

    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Remove connection"))

    expect(
      await screen.findByText(/Tasks and data on the daemon keep running/)
    ).toBeInTheDocument()
    expect(screen.getByText(/stored credential/)).toBeInTheDocument()
  })

  it("requires a second confirmation before discarding a remote draft", async () => {
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
    renderChrome(
      bootstrap([LOCAL, remote]),
      bridge({ removeConnection })
    )

    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Remove connection"))
    expect(await screen.findByText(/1 unsent draft/)).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Remove connection"))
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
    expect(
      screen.getByRole("tab", { name: "Local", hidden: true })
    ).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Reset desktop data"))
    fireEvent.click(screen.getByRole("button", { name: "Reset desktop data" }))

    expect(await screen.findByText("Connection action failed")).toBeInTheDocument()
    expect(screen.getAllByRole("alert").some((alert) =>
      alert.textContent?.includes("synthetic deferred reset cleanup")
    )).toBe(true)
    expect(screen.getByRole("tab", { name: /Local/, hidden: true })).toHaveAttribute(
      "aria-selected",
      "true"
    )
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

    fireEvent.click(screen.getByRole("button", { name: "Manage Local" }))
    fireEvent.click(await screen.findByText("Reset desktop data"))
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

    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Edit connection"))
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

    fireEvent.click(screen.getByRole("tab", { name: "Remote one" }))
    fireEvent.click(screen.getByRole("button", { name: "Manage Remote one" }))
    fireEvent.click(await screen.findByText("Reconnect"))
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
    expect(
      screen.queryByRole("tablist", { name: "Daemon connections" })
    ).toBeNull()
  })

  it("disables Add after eight total connections", () => {
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

    expect(
      screen.getByRole("button", { name: "At most 8 connections" })
    ).toBeDisabled()
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
