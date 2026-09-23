import { describe, expect, it } from "vitest"

import {
  createTaskTransitionTracker,
  finishedTransitions,
  snapshotTaskStates,
} from "./task-transitions"
import type { ApiTask, TaskState } from "./types"

function task(id: string, state: TaskState, archived = false): ApiTask {
  return {
    id,
    title: `Task ${id}`,
    repo_path: "/synthetic/repo",
    worktree_path: null,
    branch: null,
    base_commit: null,
    harness: "claude",
    model: null,
    state,
    state_detail: null,
    session_id: null,
    latest_turn_exit_code: null,
    latest_turn_has_result: false,
    archived,
    created_at: "2026-09-06T08:00:00Z",
    updated_at: "2026-09-06T08:00:00Z",
  } as unknown as ApiTask
}

describe("finished task transitions", () => {
  it("reports a running task that reached any other state", () => {
    const previous = snapshotTaskStates([
      task("t1", "running"),
      task("t2", "running"),
      task("t3", "running"),
      task("t4", "running"),
    ])
    const transitions = finishedTransitions(previous, [
      task("t1", "done"),
      task("t2", "needs-input"),
      task("t3", "failed"),
      task("t4", "stuck"),
    ])
    expect(transitions.map((t) => [t.task.id, t.from, t.to])).toEqual([
      ["t1", "running", "done"],
      ["t2", "running", "needs-input"],
      ["t3", "running", "failed"],
      ["t4", "running", "stuck"],
    ])
  })

  it("ignores tasks that were not running, are still running, or are new", () => {
    const previous = snapshotTaskStates([
      task("creating", "creating"),
      task("still", "running"),
      task("was-done", "done"),
    ])
    expect(
      finishedTransitions(previous, [
        task("creating", "failed"),
        task("still", "running"),
        task("was-done", "needs-input"),
        task("brand-new", "done"),
      ])
    ).toEqual([])
  })

  it("skips a task that was archived as it stopped", () => {
    const previous = snapshotTaskStates([task("t1", "running")])
    expect(finishedTransitions(previous, [task("t1", "done", true)])).toEqual(
      []
    )
  })
})

describe("task transition tracker", () => {
  it("seeds silently, then reports per connection, and forgets on request", () => {
    const tracker = createTaskTransitionTracker()
    expect(tracker.observe("one", [task("t1", "running")])).toEqual([])
    expect(tracker.observe("two", [task("t1", "running")])).toEqual([])

    const finished = tracker.observe("one", [task("t1", "done")])
    expect(finished.map((t) => t.task.id)).toEqual(["t1"])
    // the same list again is not a second change
    expect(tracker.observe("one", [task("t1", "done")])).toEqual([])
    // the other connection's identical task ID is its own story
    expect(tracker.observe("two", [task("t1", "running")])).toEqual([])

    tracker.forget("two")
    expect(tracker.observe("two", [task("t1", "done")])).toEqual([])
  })
})

describe("auto-merge and auto-fix news", () => {
  const armed = (id: string, state: string, over: Record<string, unknown> = {}): ApiTask => ({
    ...task(id, "done"),
    autopilot: { autoMerge: true, autoFix: true, pr: 7, state, reason: "1 review thread still open", about: "pr", by: "auto-fix", mergedByWisp: false, pendingFix: null, fixRounds: 1, updatedAt: null, ...over },
  }) as unknown as ApiTask

  it("announces a merge by Wisp, and a switch that needs a person; a first sighting only seeds", () => {
    const tracker = createTaskTransitionTracker()
    expect(tracker.observe("c1", [armed("t1", "waiting"), armed("t2", "waiting"), armed("t3", "needs-you")])).toEqual([])
    const news = tracker.observe("c1", [
      armed("t1", "merged", { mergedByWisp: true }), armed("t2", "needs-you"), armed("t3", "needs-you"),
    ])
    expect(news.map((transition) => [transition.task.id, transition.autopilot])).toEqual([["t1", "merged"], ["t2", "needs-you"]])
  })

  it("stays quiet for a merge someone else made, a pause it was already in, and an archived task", () => {
    const tracker = createTaskTransitionTracker()
    tracker.observe("c1", [armed("t1", "waiting"), armed("t2", "paused"), armed("t3", "waiting")])
    expect(tracker.observe("c1", [
      armed("t1", "merged", { mergedByWisp: false }), armed("t2", "paused"), { ...armed("t3", "needs-you"), archived: true } as ApiTask,
    ])).toEqual([])
  })
})
