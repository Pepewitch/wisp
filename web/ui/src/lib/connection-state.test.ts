import { describe, expect, it, vi } from "vitest"

import { connectionStore } from "./conn"
import { uiIntentsFor } from "./ui-intents"

describe("connection-scoped external stores", () => {
  it("keeps stream health isolated when connection IDs differ", () => {
    const first = connectionStore("connection-state-one")
    const second = connectionStore("connection-state-two")
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const stopFirst = first.subscribe(firstListener)
    const stopSecond = second.subscribe(secondListener)

    first.set("events", false)

    expect(first.isLive()).toBe(false)
    expect(second.isLive()).toBe(true)
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()
    stopFirst()
    stopSecond()
  })

  it("delivers focus intents only inside their connection", () => {
    const first = uiIntentsFor("connection-intents-one")
    const second = uiIntentsFor("connection-intents-two")
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const stopFirst = first.subscribe(firstListener)
    const stopSecond = second.subscribe(secondListener)

    first.focusStream()

    expect(first.streamFocusRequests()).toBe(1)
    expect(second.streamFocusRequests()).toBe(0)
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).not.toHaveBeenCalled()
    stopFirst()
    stopSecond()
  })
})
