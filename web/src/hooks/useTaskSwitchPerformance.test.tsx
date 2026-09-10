import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import { useTaskSwitchPerformance } from "./useTaskSwitchPerformance"

describe("useTaskSwitchPerformance", () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  it("does not record detail twice when the selected conversation refetches", async () => {
    const view = renderHook(
      ({ updatedAt }) =>
        useTaskSwitchPerformance("tselected", "tselected", updatedAt),
      { initialProps: { updatedAt: 1 } },
    )
    await waitFor(() =>
      expect(
        performance.getEntriesByName(
          "wisp:task-switch:selection-to-detail",
          "measure",
        ),
      ).toHaveLength(1),
    )

    view.rerender({ updatedAt: 2 })
    expect(
      performance.getEntriesByName(
        "wisp:task-switch:selection-to-detail",
        "measure",
      ),
    ).toHaveLength(1)
  })
})
