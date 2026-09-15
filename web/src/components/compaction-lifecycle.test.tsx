import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { ApiTask, HarnessCompact, SendResponse, Turn } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"

afterEach(() => vi.restoreAllMocks())

const compact: HarnessCompact = { kind: "prompt", prompt: "/compact" }

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
})
