import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MobileConnectionStatus } from "./conn-indicator"
import { connectionStore } from "@/lib/conn"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

afterEach(() => vi.useRealTimers())

describe("mobile connection status", () => {
  it("does not report a routine stream opening as a disconnect", () => {
    const connectionId = "mobile-stream-handoff"
    const store = connectionStore(connectionId)
    render(<MobileConnectionStatus />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(connectionId)),
    })

    act(() => store.opening("events"))
    expect(screen.queryByRole("status")).toBeNull()
    act(() => store.set("events", false))
    expect(screen.getByRole("status")).toHaveTextContent("Live updates disconnected")
    act(() => store.set("events", true))
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("warns when an opening stream stalls without an error event", () => {
    const connectionId = "mobile-stream-stalled"
    const store = connectionStore(connectionId)
    vi.useFakeTimers()
    render(<MobileConnectionStatus />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(connectionId)),
    })

    act(() => store.opening("events"))
    expect(screen.queryByRole("status")).toBeNull()
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByRole("status")).toHaveTextContent("Live updates delayed")
    act(() => store.set("events", true))
    expect(screen.queryByRole("status")).toBeNull()
  })
})
