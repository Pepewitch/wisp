import { describe, expect, it } from "vitest"

import { connectionAttention } from "./connection-attention"
import type { ApiTask, TaskState } from "./types"

const task = (
  state: TaskState,
  archived = false,
  autopilot: ApiTask["autopilot"] = undefined
): Pick<ApiTask, "state" | "archived" | "autopilot"> => ({ state, archived, autopilot })

describe("inactive connection attention", () => {
  it("uses needs-input, stuck, failed, running, creating priority", () => {
    expect(
      connectionAttention([
        task("creating"),
        task("failed"),
        task("running"),
        task("stuck"),
      ])
    ).toBe("stuck")
    expect(connectionAttention([task("failed"), task("needs-input")])).toBe(
      "needs-input"
    )
  })

  it("ignores done and archived tasks", () => {
    expect(
      connectionAttention([task("done"), task("needs-input", true)])
    ).toBeNull()
  })

  it("does not show a task paused on the network as failed", () => {
    const paused = task("failed", false, { network: { resumesAt: "2026-11-02T10:00:00Z", resume: 1, of: 3 } } as ApiTask["autopilot"])
    expect(connectionAttention([paused])).toBeNull()
    expect(connectionAttention([paused, task("running")])).toBe("running")
    expect(connectionAttention([paused, task("failed")])).toBe("failed")
  })
})
