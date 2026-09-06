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

  it("numbers task focus requests per connection so a view can skip stale ones", () => {
    const first = uiIntentsFor("connection-intents-focus-one")
    const second = uiIntentsFor("connection-intents-focus-two")
    const listener = vi.fn()
    const stop = first.subscribe(listener)

    expect(first.taskFocusRequest()).toBeNull()
    first.focusTask("t1")
    first.focusTask("t1")

    expect(first.taskFocusRequest()).toEqual({ taskId: "t1", seq: 2 })
    expect(second.taskFocusRequest()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})
