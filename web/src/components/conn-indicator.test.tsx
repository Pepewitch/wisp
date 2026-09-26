import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MobileConnectionStatus } from "./conn-indicator"
import { connectionStore } from "@/lib/conn"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

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
})
