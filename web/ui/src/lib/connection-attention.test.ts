import { describe, expect, it } from "vitest"

import { connectionAttention } from "./connection-attention"
import type { ApiTask, TaskState } from "./types"

const task = (
  state: TaskState,
  archived = false
): Pick<ApiTask, "state" | "archived"> => ({ state, archived })

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
})
