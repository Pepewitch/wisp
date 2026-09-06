import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  DesktopBootstrap,
  DesktopBridge,
  DesktopConnectionMetadata,
} from "@/lib/desktop-bridge"
import {
  DesktopApplicationProvider,
  useDesktopConnections,
} from "@/lib/desktop-connections"
import { connectionStorageKey } from "@/lib/connection-storage"
import { clearConnectionDrafts, readDraft, writeDraft } from "@/lib/drafts"

const LOCAL: DesktopConnectionMetadata = {
  id: "local",
  routeRevision: 0,
  kind: "local",
  name: "Local",
  url: null,
  instanceId: "wisp-instance-local",
  ready: true,
}
const LOCAL_ROUTE_REVISION_KEY = "wisp_desktop_local_route_revision"

function bootstrap(local: DesktopConnectionMetadata = LOCAL): DesktopBootstrap {
  return {
    connections: [local],
    activeConnectionId: "local",
    proxyBaseUrl: "http://127.0.0.1:45123/per-launch-capability",
    local: {
      available: true,
      configPath: "/synthetic/.wisp/config.json",
      baseUrl: "http://127.0.0.1:18710",
      instanceId: local.instanceId,
      hasToken: true,
      reason: null,
    },
  }
}

function bridge(overrides: Partial<DesktopBridge>): DesktopBridge {
  return {
    bootstrap: async () => bootstrap(),
    selectConnection: async () => undefined,
    probeRemoteConnection: async () => ({
      instanceId: "wisp-instance-remote",
      apiProtocolVersion: 1,
      version: "0.4.0-synthetic",
    }),
    probeSavedConnection: async () => ({
      instanceId: "wisp-instance-local",
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

function LocalReconnectHarness({
  onMount,
  onUnmount,
  onSettled,
  action = "reconnect",
}: {
  onMount: () => void
  onUnmount: () => void
  onSettled: () => void
  action?: "reconnect" | "diagnose"
}) {
  const desktop = useDesktopConnections()!
  useEffect(() => {
    onMount()
    return onUnmount
  }, [onMount, onUnmount])
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const request =
            action === "diagnose"
              ? desktop.setupLocalWisp()
              : desktop.reconnect({ connectionId: "local" })
          void request
            .catch(() => undefined)
            .finally(onSettled)
        }}
      >
        {action === "diagnose" ? "Diagnose Local now" : "Reconnect Local now"}
      </button>
      <output aria-label="local route revision">
        {desktop.active.metadata.routeRevision}
      </output>
    </>
  )
}

function renderHarness(
  nativeBridge: DesktopBridge,
  callbacks: {
    onMount: () => void
    onUnmount: () => void
    onSettled: () => void
  },
  action?: "reconnect" | "diagnose"
) {
  localStorage.setItem(LOCAL_ROUTE_REVISION_KEY, "0")
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <DesktopApplicationProvider initial={bootstrap()} bridge={nativeBridge}>
        <LocalReconnectHarness {...callbacks} action={action} />
      </DesktopApplicationProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  clearConnectionDrafts("local")
  localStorage.clear()
})

describe("Local native target revisions", () => {
  it("clears daemon-A state before a restarted webview mounts daemon B", () => {
    const retargeted = {
      ...LOCAL,
      routeRevision: 1,
      instanceId: "wisp-instance-local-after-restart",
    }
    const scopedKey = connectionStorageKey("local", "selected_task")
    localStorage.setItem(LOCAL_ROUTE_REVISION_KEY, "0")
    localStorage.setItem(scopedKey, "old-daemon-task")
    localStorage.setItem("wisp_selected_task", "old-legacy-task")
    writeDraft("local", "old-daemon-task", "old in-memory draft")
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <DesktopApplicationProvider
          initial={bootstrap(retargeted)}
          bridge={bridge({})}
        >
          <LocalReconnectHarness
            onMount={vi.fn()}
            onUnmount={vi.fn()}
            onSettled={vi.fn()}
          />
        </DesktopApplicationProvider>
      </QueryClientProvider>
    )

    expect(screen.getByLabelText("local route revision")).toHaveTextContent("1")
    expect(localStorage.getItem(LOCAL_ROUTE_REVISION_KEY)).toBe("1")
    expect(localStorage.getItem(scopedKey)).toBeNull()
    expect(localStorage.getItem("wisp_selected_task")).toBeNull()
    expect(readDraft("local", "old-daemon-task")).toBe("")
  })

  it("remounts and clears Local-owned state when the target changes", async () => {
    const retargeted = {
      ...LOCAL,
      routeRevision: 1,
      instanceId: "wisp-instance-local-replacement",
    }
    let committed = false
    const callbacks = {
      onMount: vi.fn(),
      onUnmount: vi.fn(),
      onSettled: vi.fn(),
    }
    writeDraft("local", "synthetic-task", "old daemon draft")
    const scopedKey = connectionStorageKey("local", "selected_task")
    localStorage.setItem(scopedKey, "synthetic-task")
    localStorage.setItem("wisp_selected_task", "legacy-task")
    renderHarness(
      bridge({
        reconnectConnection: async () => {
          committed = true
          return retargeted
        },
        bootstrap: async () =>
          committed ? bootstrap(retargeted) : bootstrap(),
      }),
      callbacks
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect Local now" })
    )

    await waitFor(() => expect(callbacks.onSettled).toHaveBeenCalledOnce())
    expect(screen.getByLabelText("local route revision")).toHaveTextContent("1")
    // The remount is an effect of the new revision, not of settling, so it can
    // land a flush later. Waiting still requires exactly one, on a new tree.
    await waitFor(() => expect(callbacks.onMount).toHaveBeenCalledTimes(2))
    expect(callbacks.onUnmount).toHaveBeenCalledTimes(1)
    expect(readDraft("local", "synthetic-task")).toBe("")
    expect(localStorage.getItem(scopedKey)).toBeNull()
    expect(localStorage.getItem("wisp_selected_task")).toBeNull()
  })

  it("keeps Local-owned state for a credential-only refresh", async () => {
    const callbacks = {
      onMount: vi.fn(),
      onUnmount: vi.fn(),
      onSettled: vi.fn(),
    }
    writeDraft("local", "synthetic-task", "keep this draft")
    renderHarness(
      bridge({ reconnectConnection: async () => LOCAL }),
      callbacks
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect Local now" })
    )

    await waitFor(() => expect(callbacks.onSettled).toHaveBeenCalledOnce())
    expect(callbacks.onMount).toHaveBeenCalledTimes(1)
    expect(callbacks.onUnmount).not.toHaveBeenCalled()
    expect(readDraft("local", "synthetic-task")).toBe("keep this draft")
  })

  it("applies the same invalidation when diagnosis adopts a new Local target", async () => {
    const retargeted = {
      ...LOCAL,
      routeRevision: 1,
      instanceId: "wisp-instance-local-diagnosed",
    }
    let committed = false
    const callbacks = {
      onMount: vi.fn(),
      onUnmount: vi.fn(),
      onSettled: vi.fn(),
    }
    writeDraft("local", "synthetic-task", "old diagnosis draft")
    renderHarness(
      bridge({
        setupLocalWisp: async () => {
          committed = true
          return {
            status: bootstrap(retargeted).local,
            cliPath: "/synthetic/bin/wisp",
            daemonReachable: true,
            nextStep: "ready",
            message: "Local Wisp is ready.",
          }
        },
        bootstrap: async () =>
          committed ? bootstrap(retargeted) : bootstrap(),
      }),
      callbacks,
      "diagnose"
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Diagnose Local now" })
    )

    await waitFor(() => expect(callbacks.onSettled).toHaveBeenCalledOnce())
    expect(callbacks.onMount).toHaveBeenCalledTimes(2)
    expect(callbacks.onUnmount).toHaveBeenCalledTimes(1)
    expect(readDraft("local", "synthetic-task")).toBe("")
  })
})
