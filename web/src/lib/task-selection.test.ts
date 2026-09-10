import { describe, expect, it } from "vitest"

import { reconcileSelectedTaskId } from "./task-selection"

const live = (id: string) => ({ id, archived: false })
const archived = (id: string) => ({ id, archived: true })

describe("reconcileSelectedTaskId", () => {
  it("leaves the selection alone while the list has not loaded", () => {
    expect(reconcileSelectedTaskId("t1", undefined, undefined)).toBe("t1")
    expect(reconcileSelectedTaskId(null, undefined, undefined)).toBeNull()
  })

  it("keeps a selection that is still in the list", () => {
    expect(reconcileSelectedTaskId("t2", [live("t1"), live("t2")], [live("t1"), live("t2")])).toBe(
      "t2"
    )
  })

  it("opens on the first live row when nothing is selected", () => {
    expect(reconcileSelectedTaskId(null, [archived("old"), live("t1"), live("t2")], undefined)).toBe(
      "t1"
    )
  })

  it("drops a persisted id that is missing from the first loaded list", () => {
    expect(reconcileSelectedTaskId("gone", [live("t1"), live("t2")], undefined)).toBe("t1")
  })

  it("moves off a row that vanished after it was in the previous list", () => {
    expect(
      reconcileSelectedTaskId("t1", [live("t2")], [live("t1"), live("t2")])
    ).toBe("t2")
  })

  it("keeps a newly created id until the list refetch includes it", () => {
    expect(reconcileSelectedTaskId("new", [live("t1")], [live("t1")])).toBe("new")
    expect(
      reconcileSelectedTaskId("new", [live("new"), live("t1")], [live("t1")])
    ).toBe("new")
  })

  it("keeps the first task ever created while the empty list is catching up", () => {
    expect(reconcileSelectedTaskId("new", [], [])).toBe("new")
  })

  it("falls back to an archived row when that is all that remains", () => {
    expect(reconcileSelectedTaskId(null, [archived("old")], [live("t1")])).toBe("old")
  })
})
