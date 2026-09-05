import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DesktopConnectionChrome } from "./connection-chrome"
import type { DesktopBootstrap, DesktopBridge } from "@/lib/desktop-bridge"
import { DesktopApplicationProvider } from "@/lib/desktop-connections"
import { validateConnectionName } from "@/lib/connection-validation"

const LOCAL = { id: "local", kind: "local", name: "Local", url: null } as const

function bootstrap(
  connections: DesktopBootstrap["connections"] = [LOCAL]
): DesktopBootstrap {
  return {
    connections,
    activeConnectionId: "local",
    proxyBaseUrl: "http://127.0.0.1:45123/connections",
  }
}

function bridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    bootstrap: async () => bootstrap(),
    addRemoteConnection: async () => undefined,
    renameConnection: async () => undefined,
    reconnectConnection: async () => undefined,
    removeConnection: async () => undefined,
    pickLocalProject: async () => null,
    setupLocalWisp: async () => undefined,
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

afterEach(() => vi.unstubAllGlobals())

describe("desktop connection chrome", () => {
  it("rejects hostname HTTP, invokes native with normalized input, and clears the token immediately", async () => {
    let finish!: () => void
    const addRemoteConnection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
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
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "exact loopback address"
    )
    expect(addRemoteConnection).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Token")).toHaveValue("synthetic-token")

    fireEvent.change(screen.getByLabelText("Daemon URL"), {
      target: { value: "https://remote.example.test/" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }))
    await waitFor(() =>
      expect(addRemoteConnection).toHaveBeenCalledWith({
        name: "Remote one",
        url: "https://remote.example.test",
        token: "synthetic-token",
      })
    )
    expect(screen.getByLabelText("Token")).toHaveValue("")
    finish()
  })

  it("never offers removal for the built-in local connection", async () => {
    renderChrome(bootstrap(), bridge())

    fireEvent.click(screen.getByRole("button", { name: "Manage Local" }))
    expect(await screen.findByText("Rename")).toBeInTheDocument()
    expect(screen.getByText("Set up local Wisp")).toBeInTheDocument()
    expect(screen.queryByText("Remove connection")).toBeNull()
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
