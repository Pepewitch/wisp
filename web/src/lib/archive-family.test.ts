import { describe, expect, it } from "vitest"

import { familyPlan, refusedSubtasks, withConsent, type RefusedSubtask } from "./archive-family"
import { ApiError } from "./transport"
import type { ApiTask } from "./types"

function task(id: string, extra: Record<string, unknown> = {}): ApiTask {
  return { id, title: `Task ${id}`, archived: false, parent_task_id: null, autopilot: null, ...extra } as unknown as ApiTask
}

const tasks = [
  task("p"),
  task("a", { parent_task_id: "p" }),
  task("b", { parent_task_id: "p", autopilot: { autoMerge: true, autoFix: false, autoReview: false, pr: 12, state: "watching" } }),
  task("r", { parent_task_id: "a", verify_role: "reviewer" }),
  task("gone", { parent_task_id: "p", archived: true }),
  task("other"),
]

const optIn: RefusedSubtask[] = [
  { id: "a", title: "Task a", error: "a live subtask", needs: "subtasks" },
  { id: "b", title: "Task b", error: "a live subtask", needs: "subtasks" },
]

describe("the family confirm", () => {
  it("names every live child and its reviewers, with what happens to each, and asks to take them along", () => {
    const plan = familyPlan("p", tasks, optIn, { stopAutopilot: false })
    expect(plan.members.map((m) => [m.id, m.outcome, m.refused])).toEqual([
      ["a", "archived with it", false],
      ["r", "a reviewer: its review ends, and it is archived", false],
      ["b", "archived with it; its autopilot is asked about first", false],
    ])
    expect(plan.next).toBe("archive")
  })

  it("asks to force a child that cannot go as it is, before anything about autopilot", () => {
    const refused: RefusedSubtask[] = [
      { id: "a", title: "Task a", error: "3 uncommitted changes" },
      { id: "b", title: "Task b", error: "Auto-merge is on for PR #12", needs: "stopAutopilot" },
    ]
    const plan = familyPlan("p", tasks, refused, { subtasks: "archive", stopAutopilot: false })
    expect(plan.members.filter((m) => m.refused).map((m) => [m.id, m.outcome])).toEqual([
      ["a", "3 uncommitted changes"],
      ["b", "Auto-merge is on for PR #12"],
    ])
    expect(plan.next).toBe("force")
    // forced, the autopilot is still its own question
    const after = familyPlan("p", tasks, [refused[1]!], { subtasks: "force", stopAutopilot: false })
    expect(after.next).toBe("stopAutopilot")
    expect(after.members.find((m) => m.id === "a")!.outcome).toBe("forced")
  })

  it("keeps each consent its own: forcing never stops autopilot, stopping it never forces", () => {
    expect(withConsent({ stopAutopilot: false }, "archive")).toEqual({ subtasks: "archive", stopAutopilot: false })
    expect(withConsent({ subtasks: "archive", stopAutopilot: false }, "force")).toEqual({ subtasks: "force", stopAutopilot: false })
    expect(withConsent({ subtasks: "archive", stopAutopilot: false }, "stopAutopilot")).toEqual({ subtasks: "archive", stopAutopilot: true })
    expect(familyPlan("p", tasks, optIn, { subtasks: "archive", stopAutopilot: true }).members.find((m) => m.id === "b")!.outcome)
      .toBe("archived with it; its autopilot is switched off")
  })

  it("names a refused child the list has not caught up with", () => {
    const plan = familyPlan("p", tasks, [{ id: "new", title: "Fresh", error: "turn 1 is still running" }], { subtasks: "archive", stopAutopilot: false })
    expect(plan.members.at(-1)).toEqual({ id: "new", title: "Fresh", outcome: "turn 1 is still running", refused: true })
  })

  it("reads the refused children off a 409, and nothing off any other failure", () => {
    const error = new ApiError("task p has 2 live subtasks", 409, null, { refusedSubtasks: [...optIn, { title: "no id" }, { id: "c", needs: "bogus" }] })
    expect(refusedSubtasks(error)).toEqual([...optIn, { id: "c", title: "c", error: "refused" }])
    expect(refusedSubtasks(new ApiError("dirty", 409))).toBeNull()
    expect(refusedSubtasks(new Error("offline"))).toBeNull()
  })
})
