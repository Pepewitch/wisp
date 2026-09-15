import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { ApiTask, HarnessCompact, SendResponse, Turn } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"

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
      <SteerBox
        task={task({ state: "done", turn_count: 4 })}
        compact={compact}
        turns={[compactTurn("done")]}
      />
    )
    expect(screen.getByTestId("steer-note")).toHaveTextContent("compacted")
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
    render(
      <SteerBox
        task={task({ state: "running", turn_count: 4 })}
        compact={compact}
        turns={[compactTurn("running")]}
        onSend={onSend}
      />,
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
    expect(screen.getByTestId("composer-running-row")).toHaveTextContent(
      "compacting the session…"
    )
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

    fireEvent.change(box, { target: { value: "change direction" } })
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()

    finish({ ok: true, removedCount: 3, sessionReplaced: true, note: null })
    await waitFor(() => expect(screen.getByTestId("steer-note")).toHaveTextContent("compacted"))
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })
})
