import { afterEach, describe, expect, it } from "vitest"

import {
  clearConnectionDrafts,
  connectionLocalData,
  createTaskScope,
  readCreateTaskDraft,
  readCreateTaskProject,
  writeCreateTaskDraft,
  writeCreateTaskProject,
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
    writePendingAttachmentCount(CONNECTION, "task-one", 2)
    writePendingAttachmentCount("other-connection", "task-one", 3)
    clearConnectionDrafts(CONNECTION)

    expect(connectionLocalData(CONNECTION)).toEqual({
      drafts: 0,
      pendingAttachments: 0,
    })
    expect(connectionLocalData("other-connection")).toEqual({
      drafts: 1,
      pendingAttachments: 3,
    })
    clearConnectionDrafts("other-connection")
  })

  it("counts and clears project-scoped create drafts with their connection", () => {
    const draft = {
      prompt: "unfinished work",
      choice: { harness: "droid", model: "synthetic-model" },
      effort: "",
      fast: false,
      mode: "worktree" as const,
      base: "",
      suffixPromptId: null,
      autopilot: { autoMerge: false, autoFix: false },
    }
    writeCreateTaskDraft(CONNECTION, "/repo", draft)
    writeCreateTaskProject(CONNECTION, "/repo")
    writePendingAttachmentCount(CONNECTION, createTaskScope("/repo"), 1)
    expect(connectionLocalData(CONNECTION)).toEqual({ drafts: 1, pendingAttachments: 1 })

    clearConnectionDrafts(CONNECTION)
    expect(readCreateTaskDraft(CONNECTION, "/repo")).toBeUndefined()
    expect(readCreateTaskProject(CONNECTION)).toBeUndefined()
    expect(connectionLocalData(CONNECTION)).toEqual({ drafts: 0, pendingAttachments: 0 })
  })
})
