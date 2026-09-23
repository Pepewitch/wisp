import { describe, expect, it } from "vitest"

import type { ApiTask } from "@/lib/types"

import { headerTask } from "./header-task"

const row = { id: "t1", title: "list row", autopilot: { autoMerge: true, autoFix: false, pr: 7, state: "waiting", reason: "Waiting for checks", about: "pr", mergedByWisp: false, updatedAt: null } } as unknown as ApiTask
const detail = { id: "t1", title: "detail row" } as unknown as ApiTask

describe("the header's task", () => {
  it("is the detail once loaded, carrying auto-merge from the list row the detail endpoint does not serve", () => {
    const header = headerTask(detail, row)!
    expect(header.title).toBe("detail row")
    expect(header.autopilot).toEqual(row.autopilot)
  })

  it("is the list row before the detail loads, and never mixes two different tasks", () => {
    expect(headerTask(undefined, row)).toBe(row)
    expect(headerTask({ ...detail, id: "t2" } as ApiTask, row)?.autopilot).toBeUndefined()
    expect(headerTask(undefined, null)).toBeNull()
  })
})
