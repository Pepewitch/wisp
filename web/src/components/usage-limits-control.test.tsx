import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { HarnessLimitsEntry } from "@/lib/types"
import type { DaemonTransport } from "@/lib/transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { UsageLimitsControl, UsageLimitsPopover } from "./usage-limits-control"

const fetchedAt = new Date().toISOString()
const soon = new Date(Date.now() + (2 * 60 + 14) * 60_000 + 30_000).toISOString()

const CLAUDE: HarnessLimitsEntry = {
  name: "claude",
  status: "ok",
  limits: {
    plan: null,
    windows: [
      { id: "session", label: "5h", pool: null, usedPercent: 27, resetsAt: soon, windowMins: 300 },
      { id: "week", label: "7d", pool: null, usedPercent: 12, resetsAt: null, windowMins: 10_080 },
    ],
  },
  message: null,
  fetchedAt,
  cached: false,
}

const DROID_NEEDS_KEY: HarnessLimitsEntry = {
  name: "droid",
  status: "needs-key",
  limits: null,
  message: "Add a Factory API key in Settings to show droid's limits.",
  fetchedAt,
  cached: false,
}

function daemon(features: Record<string, boolean>, harnesses: HarnessLimitsEntry[]) {
  const request = vi.fn().mockImplementation((path: string) => {
    if (path === "/api/harnesses") return Promise.resolve({ harnesses: [], features })
    if (path.startsWith("/api/harness-limits")) return Promise.resolve({ harnesses })
    return Promise.reject(new Error(`unexpected ${path}`))
  })
  const transport = fakeDaemonTransport("local", { request: request as DaemonTransport["request"] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { request, wrapper: runtimeWrapper(transport, client) }
}

describe("the usage limits control", () => {
  it("is absent on a daemon that cannot read limits, and never asks", async () => {
    const { request, wrapper } = daemon({}, [CLAUDE])
    const { container } = render(<UsageLimitsControl harness="claude" onOpenSettings={() => {}} />, { wrapper })
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/harnesses"))
    expect(container).toBeEmptyDOMElement()
    expect(request).not.toHaveBeenCalledWith("/api/harness-limits")
  })

  it("names the selected task's harness and its shortest window", async () => {
    const { wrapper } = daemon({ harnessLimits: true }, [CLAUDE, DROID_NEEDS_KEY])
    render(<UsageLimitsControl harness="claude" onOpenSettings={() => {}} />, { wrapper })
    expect(await screen.findByRole("button", { name: "Usage limits, claude 5h 27% used" })).toBeInTheDocument()
  })

  it("is an empty ring with no task, or for a harness with nothing to show", async () => {
    const { wrapper } = daemon({ harnessLimits: true }, [CLAUDE, DROID_NEEDS_KEY])
    const { rerender } = render(<UsageLimitsControl harness={null} onOpenSettings={() => {}} />, { wrapper })
    expect(await screen.findByRole("button", { name: "Usage limits" })).toBeInTheDocument()
    rerender(<UsageLimitsControl harness="droid" onOpenSettings={() => {}} />)
    expect(screen.getByRole("button", { name: "Usage limits" })).toBeInTheDocument()
  })

  it("refreshes past the daemon's cache on request", async () => {
    const { request, wrapper } = daemon({ harnessLimits: true }, [CLAUDE])
    render(<UsageLimitsControl harness="claude" onOpenSettings={() => {}} />, { wrapper })
    fireEvent.click(await screen.findByRole("button", { name: /Usage limits/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/harness-limits?refresh=1"))
  })
})

describe("the usage limits popover", () => {
  it("shows every window with a bar filled by the share used and when it resets", () => {
    render(
      <UsageLimitsPopover
        entries={[CLAUDE, DROID_NEEDS_KEY]}
        harness="claude"
        onRefresh={() => {}}
        onOpenSettings={() => {}}
        defaultOpen
      />,
    )
    const claude = screen.getByRole("region", { name: "claude usage limits" })
    expect(within(claude).getByText("this task")).toBeInTheDocument()
    const meters = within(claude).getAllByRole("meter")
    expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
      ["5h used", "27"],
      ["7d used", "12"],
    ])
    expect(within(claude).getByText("resets in 2h 14m")).toBeInTheDocument()
    expect(screen.getByText(/^Updated /)).toBeInTheDocument()
  })

  it("sends a harness that needs a key to Settings", () => {
    const onOpenSettings = vi.fn()
    render(
      <UsageLimitsPopover
        entries={[DROID_NEEDS_KEY]}
        harness={null}
        onRefresh={() => {}}
        onOpenSettings={onOpenSettings}
        defaultOpen
      />,
    )
    const droid = screen.getByRole("region", { name: "droid usage limits" })
    expect(within(droid).getByText(DROID_NEEDS_KEY.message!)).toBeInTheDocument()
    fireEvent.click(within(droid).getByRole("button", { name: "Settings…" }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it("says so when no harness reports limits, and when the read failed", () => {
    const { rerender } = render(
      <UsageLimitsPopover entries={[]} harness={null} onRefresh={() => {}} onOpenSettings={() => {}} defaultOpen />,
    )
    expect(screen.getByText("No harness on this daemon reports plan limits.")).toBeInTheDocument()
    rerender(
      <UsageLimitsPopover
        entries={undefined}
        error={new Error("daemon unreachable")}
        harness={null}
        onRefresh={() => {}}
        onOpenSettings={() => {}}
        defaultOpen
      />,
    )
    expect(screen.getByText("Could not read usage limits: daemon unreachable")).toBeInTheDocument()
  })
})
