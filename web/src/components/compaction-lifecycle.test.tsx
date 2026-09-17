import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { ApiTask, HarnessCompact, SendResponse, Turn } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"
import { TurnProgress } from "./turn-progress"

afterEach(() => vi.restoreAllMocks())

const compact: HarnessCompact = { kind: "prompt", prompt: "/compact" }
const actionCompact: HarnessCompact = { kind: "action", recordsTurn: false }

const task = (over: Partial<ApiTask> = {}): ApiTask =>
  ({
    id: "tcompact",
    title: "Compact task",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/worktree",
    branch: "wisp/tcompact",
    base_commit: "abc123",
    harness: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: "session-1",
    seq: 1,
    turn_count: 3,
    archived: false,
    mode: "worktree",
    created_at: "2026-09-15T00:00:00Z",
    updated_at: "2026-09-15T00:00:00Z",
    ...over,
  }) as ApiTask

const compactTurn = (status: Turn["status"]): Turn =>
  ({
    id: 4,
    task_id: "tcompact",
    n: 4,
    prompt: "/compact",
    operation: "compact",
    result: null,
    status,
    model: "claude-sonnet-4-6",
    usage: null,
    attachments: [],
    log_file: "/tmp/compact.log",
    started_at: "2026-09-15T00:00:00Z",
    ended_at: status === "running" ? null : "2026-09-15T00:01:00Z",
  }) as Turn

function chooseAndSend(): HTMLTextAreaElement {
  const box = screen.getByPlaceholderText(
    "Ask for changes, or / for commands"
  ) as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: "/comp", selectionStart: 5 } })
  fireEvent.click(screen.getByTestId("slash-compact"))
  fireEvent.click(screen.getByRole("button", { name: /Send/ }))
  return box
}

describe("prompt compaction lifecycle", () => {
  it("uses codex's compacting/compacted wording around the recorded turn", async () => {
    const response = {
      ...task({ state: "running", turn_count: 4 }),
      disposition: "started",
      operation: "compact",
      message: { turn_n: 4, delivery_uncertain: false },
    } as SendResponse
    const transport = fakeDaemonTransport("test-connection", {
      request: async <T,>() => response as T,
    })
    const view = render(
      <SteerBox task={task()} compact={compact} turns={[]} />,
      {
        wrapper: runtimeWrapper(transport),
      }
    )
    chooseAndSend()

    await waitFor(() =>
      expect(screen.getByTestId("steer-note")).toHaveTextContent(
        "compacting the session…"
      )
    )

    view.rerender(
      <>
        <TurnProgress turn={compactTurn("done")} hasLiveItems={false} />
        <SteerBox
          task={task({ state: "done", turn_count: 4 })}
          compact={compact}
          turns={[compactTurn("done")]}
        />
      </>
    )
    expect(screen.getAllByText("compacted")).toHaveLength(1)
    expect(screen.queryByTestId("steer-note")).toBeNull()
  })

  it("keeps the compact draft when an active turn refuses it", async () => {
    const transport = fakeDaemonTransport("test-connection", {
      request: async () => {
        throw new ApiError(
          "turn 4 is still running — compaction waits for it",
          409
        )
      },
    })
    render(
      <SteerBox
        task={task({ state: "running", turn_count: 4 })}
        compact={compact}
      />,
      { wrapper: runtimeWrapper(transport) }
    )
    const box = chooseAndSend()

    await waitFor(() =>
      expect(screen.getByTestId("steer-note")).toHaveTextContent(
        "turn 4 is still running — compaction waits for it"
      )
    )
    expect(box).toHaveValue("/compact")
  })

  it("blocks steering while the compact turn is running", () => {
    const onSend = vi.fn()
    const turn = compactTurn("running")
    render(
      <>
        <TurnProgress turn={turn} hasLiveItems={false} />
        <SteerBox
          task={task({ state: "running", turn_count: 4 })}
          compact={compact}
          turns={[turn]}
          onSend={onSend}
        />
      </>,
      { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection")) }
    )
    const box = screen.getByPlaceholderText(
      "Ask for changes, or / for commands"
    )
    fireEvent.change(box, { target: { value: "change direction" } })
    const send = screen.getByRole("button", { name: "Send safely" })
    expect(send).toBeDisabled()
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getAllByText("compacting the session…")).toHaveLength(1)
    expect(screen.queryByTestId("composer-running-row")).toBeNull()
    expect(screen.queryByTestId("steer-note")).toBeNull()
  })
})

describe("action compaction lifecycle", () => {
  it("blocks steering until the action completes", async () => {
    let finish!: (answer: {
      ok: boolean
      removedCount: number | null
      sessionReplaced: boolean
      note: string | null
    }) => void
    const transport = fakeDaemonTransport("test-connection", {
      request: <T,>() => new Promise<T>((resolve) => {
        finish = (answer) => resolve(answer as T)
      }),
    })
    const onSend = vi.fn()
    render(
      <SteerBox
        task={task({ harness: "droid", model: "kimi-k3" })}
        compact={actionCompact}
        turns={[]}
        onSend={onSend}
      />,
      { wrapper: runtimeWrapper(transport) }
    )
    const box = screen.getByPlaceholderText(
      "Ask for changes, or / for commands"
    )
    fireEvent.change(box, { target: { value: "/comp", selectionStart: 5 } })
    fireEvent.click(screen.getByTestId("slash-compact"))
    expect(await screen.findByTestId("steer-note")).toHaveTextContent(
      "compacting the session…"
    )
    expect(screen.getAllByText("compacting the session…")).toHaveLength(1)

    fireEvent.change(box, { target: { value: "change direction" } })
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()

    finish({ ok: true, removedCount: 3, sessionReplaced: true, note: null })
    await waitFor(() => expect(screen.getByTestId("steer-note")).toHaveTextContent("compacted"))
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("refetches the task list, because this compaction fires no daemon event", async () => {
    // The header's context reading lives on the task LIST row, and an action
    // compaction writes no turn and emits nothing — so the client that ran it
    // is the only thing that can tell the UI the old number is retired.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidated = vi.spyOn(client, "invalidateQueries")
    const transport = fakeDaemonTransport("test-connection", {
      request: async <T,>() =>
        ({ ok: true, removedCount: 3, sessionReplaced: true, note: null }) as T,
    })
    render(
      <SteerBox
        task={task({ harness: "droid", model: "kimi-k3" })}
        compact={actionCompact}
        turns={[]}
      />,
      { wrapper: runtimeWrapper(transport, client) }
    )
    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.change(box, { target: { value: "/comp", selectionStart: 5 } })
    fireEvent.click(screen.getByTestId("slash-compact"))

    await waitFor(() => expect(screen.getByTestId("steer-note")).toHaveTextContent("compacted"))
    const keys = invalidated.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey))
    expect(keys.some((key) => key?.includes("tasks"))).toBe(true)
  })
})
