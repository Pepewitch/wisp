import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { groupMessages } from "@/hooks/useMessageGroups"
import type { ActivityEvent, ApiTask, ConversationDetail, TaskMessage, Turn } from "@/lib/types"
import { nestTasks } from "@/lib/subtask-tree"
import { initialStreamState, streamReducer, type StreamState } from "@/stream/reducer"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { Conversation } from "./conversation"
import { TaskTree } from "./subtask-rows"

/*
 * What a frame, a refetch or a sidebar redraw is allowed to redraw. Each row
 * counts its own renders through a hook it calls exactly once per render.
 */
const counts = vi.hoisted(() => ({ steps: 0, rows: 0 }))
vi.mock("@/lib/activity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/activity")>()
  return { ...real, summarizeStep: (...args: Parameters<typeof real.summarizeStep>) => { counts.steps++; return real.summarizeStep(...args) } }
})
vi.mock("@/hooks/useArchiveFlow", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/hooks/useArchiveFlow")>()
  return { ...real, useArchiveFlow: (...args: Parameters<typeof real.useArchiveFlow>) => { counts.rows++; return real.useArchiveFlow(...args) } }
})

afterEach(() => { counts.steps = 0; counts.rows = 0 })

const tool = (n: number): ActivityEvent[] => [
  { kind: "tool", id: `t${n}`, parentId: null, phase: "started", name: "Read", input: { file_path: `/work/f${n}.ts` } },
  { kind: "tool", id: `t${n}`, parentId: null, phase: "completed", name: "tool", output: "ok" },
]

function runningTask(messages: TaskMessage[] = []): ConversationDetail {
  return {
    id: "tframes", title: "Frames", repo_path: "/synthetic/repo", worktree_path: "/synthetic/worktree",
    branch: "wisp/tframes", base_commit: null, harness: "fake", model: null, effort: null, slot: 1,
    state: "running", state_detail: null, session_id: null, seq: 1, turn_count: 1, archived: false, mode: "worktree",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", messages,
    turns: [{
      id: 1, task_id: "tframes", n: 1, prompt: "Read everything", result: null, status: "running", model: null,
      usage: null, attachments: [], log_file: "/synthetic/log", started_at: "2026-01-01T00:00:00Z", ended_at: null,
    }],
  } as ConversationDetail
}

const append = (state: StreamState, activity: ActivityEvent[]) => streamReducer(state, { type: "append", turn: 1, activity })

describe("a live frame", () => {
  it("redraws only the step it added, not the hundred before it", () => {
    let stream = streamReducer(initialStreamState, {
      type: "backlog", turn: 1, prompt: "Read everything", activity: Array.from({ length: 100 }, (_, n) => tool(n)).flat(),
    })
    const task = runningTask()
    const view = render(<Conversation task={task} stream={stream} />, { wrapper: runtimeWrapper(fakeDaemonTransport("frames")) })
    expect(screen.getByText("/work/f99.ts")).toBeInTheDocument()
    counts.steps = 0

    stream = append(stream, tool(100))
    view.rerender(<Conversation task={task} stream={stream} />)
    expect(screen.getByText("/work/f100.ts")).toBeInTheDocument()
    expect(counts.steps).toBe(1)

    // a refetch that changed nothing this turn draws redraws nothing at all
    counts.steps = 0
    view.rerender(<Conversation task={{ ...task, updated_at: "2026-01-01T00:00:05Z" }} stream={stream} />)
    expect(counts.steps).toBe(0)
  })
})

describe("a long history", () => {
  it("lets layout skip settled turns off screen, never the latest or the running one", () => {
    const task = runningTask()
    const settled = (n: number) => ({ ...task.turns[0]!, id: n, n, prompt: `prompt ${n}`, result: `answer ${n}`, status: "done", ended_at: "2026-01-01T00:01:00Z" })
    const turns = [settled(1), settled(2), { ...task.turns[0]!, id: 3, n: 3 }] as Turn[]
    const { container } = render(<Conversation task={{ ...task, turns }} stream={initialStreamState} />, { wrapper: runtimeWrapper(fakeDaemonTransport("skipped")) })
    const skipped = (n: number) => container.querySelector(`[data-turn='${n}'] > .\\[content-visibility\\:auto\\]`) !== null
    expect([skipped(1), skipped(2), skipped(3)]).toEqual([true, true, false])
    // the bubble stays outside what is skipped: its toolbar hangs above it
    expect(container.querySelector("[data-turn='1'] .\\[content-visibility\\:auto\\] [data-turn-prompt]")).toBeNull()
    // and the words stay in the document, where find-in-task reads them
    expect(container.querySelector("[data-turn='1']")).toHaveTextContent("answer 1")

    const latestSettled = [settled(1), settled(2)] as Turn[]
    const { container: done } = render(<Conversation task={{ ...task, state: "done", turns: latestSettled }} stream={initialStreamState} />, { wrapper: runtimeWrapper(fakeDaemonTransport("skipped-done")) })
    expect(done.querySelector("[data-turn='2'] > .\\[content-visibility\\:auto\\]")).toBeNull()
  })
})

describe("a turn's steered messages", () => {
  const message = (id: string, turn: number) => ({ id, turn_n: turn, status: "delivered", delivery: "steered", text: id }) as TaskMessage

  it("keep last time's array for a turn whose rows did not change", () => {
    const a = message("a", 1)
    const b = message("b", 2)
    const before = groupMessages([a, b], null)
    const c = message("c", 2)
    const after = groupMessages([a, b, c], before)
    expect(after.steeredMessages.get(1)).toBe(before.steeredMessages.get(1))
    expect(after.steeredMessages.get(2)).not.toBe(before.steeredMessages.get(2))
    expect(after.steeredMessages.get(2)).toEqual([b, c])
  })
})

describe("the sidebar", () => {
  const at = "2026-01-01T00:00:00Z"
  const row = (id: string, extra: Partial<ApiTask> = {}) =>
    ({ id, title: `Task ${id}`, repo_path: "/src/wisp", state: "done", archived: false, parent_task_id: null, created_at: at, updated_at: at, background: { state: "none" }, ...extra }) as ApiTask
  const view = { disclosure: { isOpen: () => false, toggle: () => {} }, titleOf: () => null }

  it("redraws only the row whose task changed when the main view re-renders", () => {
    const tasks = Array.from({ length: 50 }, (_, n) => row(`t${n}`))
    const nodes = nestTasks(tasks)
    const tree = (list = nodes, selectedId: string | null = null) => (
      // a fresh view and handler each time, as the main view hands them over
      <TaskTree nodes={list} view={{ ...view }} selectedId={selectedId} onSelect={stableSelect} touch={false} />
    )
    const stableSelect = () => {}
    const { rerender } = render(tree(), { wrapper: runtimeWrapper(fakeDaemonTransport("sidebar-rows")) })
    expect(counts.rows).toBe(50)

    counts.rows = 0
    rerender(tree())
    expect(counts.rows).toBe(0)

    rerender(tree(nestTasks(tasks.map((task, n) => (n === 7 ? { ...task, state: "running" } : task))), "t3"))
    // the changed row, and the row that became selected
    expect(counts.rows).toBe(2)
  })
})
