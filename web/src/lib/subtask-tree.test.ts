import { describe, expect, it } from "vitest"

import {
  ancestorIds,
  archivePartitions,
  isOrphan,
  nestTasks,
  parentOutside,
  rollup,
  sidebarLists,
  visibleRows,
  visibleTaskIds,
  type TaskNode,
} from "./subtask-tree"
import type { ApiTask, TaskState } from "./types"

function task(id: string, extra: Partial<ApiTask> & { at?: string; made?: string } = {}): ApiTask {
  const { at = "2026-10-01T08:00:00Z", made = "2026-10-01T08:00:00Z", ...rest } = extra
  return {
    id,
    title: `Task ${id}`,
    repo_path: "/synthetic/repo",
    state: "done" as TaskState,
    archived: false,
    parent_task_id: null,
    subtask_kind: null,
    created_at: made,
    updated_at: at,
    ...rest,
  } as unknown as ApiTask
}

const child = (id: string, parent: string, extra: Partial<ApiTask> & { at?: string; made?: string } = {}) =>
  task(id, { parent_task_id: parent, subtask_kind: "explore", ...extra })
const reviewer = (id: string, parent: string, state: TaskState) =>
  task(id, { parent_task_id: parent, subtask_kind: "review", verify_role: "reviewer", state })

const shape = (nodes: readonly TaskNode[]): unknown[] =>
  nodes.map((node) => (node.children.length ? [node.task.id, shape(node.children)] : node.task.id))

describe("nesting", () => {
  it("puts children under their parent, in the order they were made, and a reviewer a level further down", () => {
    const tasks = [
      child("c2", "p", { made: "2026-10-01T09:02:00Z" }),
      task("p"),
      child("c1", "p", { made: "2026-10-01T09:01:00Z" }),
      reviewer("r1", "c1", "running"),
    ]
    expect(shape(nestTasks(tasks))).toEqual([["p", [["c1", ["r1"]], "c2"]]])
  })

  it("sorts roots by their family's latest activity, so a parent with a busy child does not sink", () => {
    const tasks = [
      task("recent", { at: "2026-10-01T10:00:00Z" }),
      task("quiet", { at: "2026-10-01T07:00:00Z" }),
      child("busy", "quiet", { at: "2026-10-01T11:00:00Z" }),
    ]
    expect(shape(nestTasks(tasks))).toEqual([["quiet", ["busy"]], "recent"])
  })

  it("draws a subtask whose parent is not in the list as a root, naming the parent; an orphan names none", () => {
    const tasks = [child("c", "gone-elsewhere"), task("o", { subtask_kind: "review" })]
    const nodes = nestTasks(tasks)
    expect(shape(nodes)).toEqual(["c", "o"])
    expect(parentOutside(nodes[0]!.task, 0)).toBe("gone-elsewhere")
    expect(isOrphan(nodes[1]!.task)).toBe(true)
    expect(isOrphan(nodes[0]!.task)).toBe(false)
    // nested, the parent is the row above: nothing to name
    expect(parentOutside(nodes[0]!.task, 1)).toBeNull()
  })

  it("loses no task to a cycle no daemon writes", () => {
    const rows = visibleRows(nestTasks([child("a", "b"), child("b", "a")]), () => true)
    expect(rows.map((row) => row.node.task.id).sort()).toEqual(["a", "b"])
  })
})

describe("the rollup", () => {
  const family = (...children: ApiTask[]) => nestTasks([task("p"), ...children])[0]!

  it("is running when any subtask runs, a reviewer included, at any depth", () => {
    expect(rollup(family(child("c", "p"), reviewer("r", "c", "running")))).toEqual({ running: true, needsInput: false })
    expect(rollup(family(reviewer("r", "p", "running")))).toEqual({ running: true, needsInput: false })
  })

  it("needs input when a subtask does, but never for a reviewer, which Wisp answers", () => {
    expect(rollup(family(child("c", "p", { state: "needs-input" })))).toEqual({ running: false, needsInput: true })
    expect(rollup(family(reviewer("r", "p", "needs-input")))).toEqual({ running: false, needsInput: false })
    expect(rollup(family(child("c", "p"), reviewer("r", "c", "needs-input")))).toEqual({ running: false, needsInput: false })
  })

  it("leaves out the parent's own state", () => {
    expect(rollup(nestTasks([task("p", { state: "running" })])[0]!)).toEqual({ running: false, needsInput: false })
  })
})

describe("what is on screen", () => {
  const nodes = nestTasks([task("p"), child("c", "p"), reviewer("r", "c", "done"), task("q", { at: "2026-09-01T00:00:00Z" })])

  it("hides a collapsed parent's children, and indents an open one's", () => {
    const rows = (open: string[]) => visibleRows(nodes, (id) => open.includes(id)).map((row) => [row.node.task.id, row.depth])
    expect(rows([])).toEqual([["p", 0], ["q", 0]])
    expect(rows(["p"])).toEqual([["p", 0], ["c", 1], ["q", 0]])
    expect(rows(["p", "c"])).toEqual([["p", 0], ["c", 1], ["r", 2], ["q", 0]])
    // an open child under a collapsed parent stays hidden
    expect(rows(["c"])).toEqual([["p", 0], ["q", 0]])
  })

  it("names every ancestor of a selected child, nearest first", () => {
    const tasks = [task("p"), child("c", "p"), reviewer("r", "c", "done")]
    expect(ancestorIds(tasks, "r")).toEqual(["c", "p"])
    expect(ancestorIds(tasks, "p")).toEqual([])
    expect(ancestorIds(tasks, null)).toEqual([])
    expect(ancestorIds([child("a", "b"), child("b", "a")], "a")).toEqual(["b", "a"])
  })
})

describe("the sidebar's lists", () => {
  const cleaning = { state: "running" } as ApiTask["cleanup"]
  const finished = { state: "complete" } as ApiTask["cleanup"]

  it("keeps Cleanup before Archived, and nests within each", () => {
    const archived = [
      task("ap", { archived: true, cleanup: finished }),
      reviewer("ar", "ap", "done"),
      task("cp", { archived: true, cleanup: cleaning }),
      { ...child("cc", "cp"), archived: true, cleanup: cleaning },
    ].map((t) => ({ ...t, archived: true, cleanup: t.cleanup ?? finished }))
    expect(archivePartitions(archived).map((part) => [part.label, part.tasks.map((t) => t.id)])).toEqual([
      ["Cleanup", ["cp", "cc"]],
      ["Archived", ["ap", "ar"]],
    ])
    const lists = sidebarLists([], archived, true)
    expect(lists.map((list) => [list.key, shape(list.nodes)])).toEqual([
      ["archive:Cleanup", [["cp", ["cc"]]]],
      ["archive:Archived", [["ap", ["ar"]]]],
    ])
  })

  it("is flat when the daemon has no subtasks", () => {
    const lists = sidebarLists([{ path: "/synthetic/repo", tasks: [task("p"), child("c", "p")] }], [], false)
    expect(lists.map((list) => shape(list.nodes))).toEqual([["p", "c"], [], []])
  })

  it("steps through only the rows on screen", () => {
    const lists = sidebarLists(
      [{ path: "/synthetic/repo", tasks: [task("p"), child("c", "p")] }],
      [task("old", { archived: true, cleanup: finished })],
      true,
    )
    expect(visibleTaskIds(lists, () => false)).toEqual(["p", "old"])
    expect(visibleTaskIds(lists, (id) => id === "p")).toEqual(["p", "c", "old"])
  })
})
