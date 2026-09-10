import { beforeEach, describe, expect, it, vi } from "vitest"

type Timings = typeof import("./task-switch-performance")

let timings: Timings

describe("task-switch performance marks", () => {
  beforeEach(async () => {
    vi.resetModules()
    timings = await import("./task-switch-performance")
    performance.clearMarks()
    performance.clearMeasures()
  })

  it("records content-free detail and paint durations", () => {
    const frame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(performance.now())
        return 1
      })
    try {
      timings.markTaskSelected()
      timings.markConversationDetailLoaded()
      timings.scheduleConversationPaint()

      expect(
        performance.getEntriesByName(
          "wisp:task-switch:selection-to-detail",
          "measure"
        )
      ).toHaveLength(1)
      expect(
        performance.getEntriesByName(
          "wisp:task-switch:selection-to-paint",
          "measure"
        )
      ).toHaveLength(1)
      for (const entry of performance.getEntriesByType("mark")) {
        expect(entry.name).not.toContain("task-id")
        expect(entry.name).not.toContain("connection")
      }
    } finally {
      frame.mockRestore()
    }
  })

  it("drops a scheduled paint after another task is selected", () => {
    const callbacks: FrameRequestCallback[] = []
    const frame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((next) => {
        callbacks.push(next)
        return 1
      })
    try {
      timings.markTaskSelected()
      timings.scheduleConversationPaint()
      timings.markTaskSelected()
      callbacks[0]?.(performance.now())

      expect(
        performance.getEntriesByName(
          "wisp:task-switch:selection-to-paint",
          "measure"
        )
      ).toHaveLength(0)
    } finally {
      frame.mockRestore()
    }
  })
})
