import { afterEach, describe, expect, it } from "vitest"

import {
  clearConnectionDrafts,
  connectionLocalData,
  writeDraft,
  writePendingAttachmentCount,
} from "./drafts"

const CONNECTION = "synthetic-connection"

afterEach(() => clearConnectionDrafts(CONNECTION))

describe("connection-local unsent data", () => {
  it("counts drafts and pending attachments across task scopes", () => {
    writeDraft(CONNECTION, "task-one", "first")
    writeDraft(CONNECTION, "task-two", "second")
    writePendingAttachmentCount(CONNECTION, "task-one", 1)
    writePendingAttachmentCount(CONNECTION, "task-two", 2)

    expect(connectionLocalData(CONNECTION)).toEqual({
      drafts: 2,
      pendingAttachments: 3,
    })
  })

  it("clears only the removed connection", () => {
    writeDraft(CONNECTION, "task-one", "first")
    writeDraft("other-connection", "task-one", "other")
    clearConnectionDrafts(CONNECTION)

    expect(connectionLocalData(CONNECTION).drafts).toBe(0)
    expect(connectionLocalData("other-connection").drafts).toBe(1)
    clearConnectionDrafts("other-connection")
  })
})
