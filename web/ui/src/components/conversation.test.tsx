import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import type { TaskDetail } from "@/lib/types"
import { initialStreamState } from "@/stream/reducer"

import { Conversation } from "./conversation"

describe("Conversation top fade", () => {
  it("reserves the fade's height before the first prompt", () => {
    const task = {
      id: "tspace",
      title: "Keep the first prompt below the fade",
      repo_path: "/tmp/repo",
      worktree_path: "/tmp/worktree",
      branch: "wisp/tspace-fade",
      base_commit: "abc123",
      harness: "cursor",
      model: "cursor-grok-4.6-high",
      effort: null,
      slot: 0,
      state: "done",
      state_detail: null,
      session_id: "session-1",
      seq: 1,
      turn_count: 1,
      archived: false,
      mode: "worktree",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:01Z",
      diffstat: null,
      worktreeReason: null,
      turns: [
        {
          id: 1,
          task_id: "tspace",
          n: 1,
          prompt: "The first prompt must stay fully visible.",
          result: "Done.",
          status: "done",
          model: "cursor-grok-4.6-high",
          usage: null,
          attachments: [],
          log_file: "/tmp/turn.log",
          started_at: "2026-09-03T00:00:00Z",
          ended_at: "2026-09-03T00:00:01Z",
        },
      ],
    } as TaskDetail

    render(<Conversation task={task} stream={initialStreamState} />)

    const viewport = screen.getByTestId("conversation-viewport")
    expect(viewport.firstElementChild).toHaveClass("pt-6")
    expect(viewport.querySelector("[data-turn='1']")).not.toHaveClass("pt-2")
  })

  it("places steered messages inside their turn and keeps fallback messages visibly queued", () => {
    const task = {
      id: "tmessages",
      title: "Show message delivery honestly",
      repo_path: "/tmp/repo",
      worktree_path: "/tmp/worktree",
      branch: "wisp/tmessages",
      base_commit: "abc123",
      harness: "droid",
      model: "fake",
      effort: null,
      slot: 0,
      state: "running",
      state_detail: "turn 1",
      session_id: "session-1",
      seq: 1,
      turn_count: 1,
      archived: false,
      mode: "worktree",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:01Z",
      diffstat: null,
      worktreeReason: null,
      turns: [
        {
          id: 1,
          task_id: "tmessages",
          n: 1,
          prompt: "Original request",
          result: null,
          status: "running",
          model: "fake",
          usage: null,
          attachments: [],
          log_file: "/tmp/turn.log",
          started_at: "2026-09-03T00:00:00Z",
          ended_at: null,
        },
      ],
      messages: [
        {
          id: "m-started",
          task_id: "tmessages",
          text: "Original request",
          status: "delivered",
          delivery: "started",
          turn_n: 1,
          delivery_uncertain: true,
          attachments: [],
          created_at: "2026-09-03T00:00:00Z",
          updated_at: "2026-09-03T00:00:00Z",
        },
        {
          id: "m-steered",
          task_id: "tmessages",
          text: "Use the safer approach",
          status: "delivered",
          delivery: "steered",
          turn_n: 1,
          delivery_uncertain: false,
          attachments: [],
          created_at: "2026-09-03T00:00:01Z",
          updated_at: "2026-09-03T00:00:01Z",
        },
        {
          id: "m-queued",
          task_id: "tmessages",
          text: "Then add tests",
          status: "queued",
          delivery: null,
          turn_n: null,
          delivery_uncertain: false,
          attachments: [],
          created_at: "2026-09-03T00:00:02Z",
          updated_at: "2026-09-03T00:00:02Z",
        },
        {
          id: "m-cancelled",
          task_id: "tmessages",
          text: "Do not retry this",
          status: "cancelled",
          delivery: null,
          turn_n: null,
          delivery_uncertain: true,
          attachments: [],
          created_at: "2026-09-03T00:00:03Z",
          updated_at: "2026-09-03T00:00:03Z",
        },
      ],
    } as TaskDetail
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

    const view = render(
      <QueryClientProvider client={client}>
        <Conversation task={task} stream={initialStreamState} />
      </QueryClientProvider>,
    )

    expect(screen.getByText("Use the safer approach")).toBeInTheDocument()
    expect(screen.getByText(/retried after an unconfirmed delivery/)).toBeInTheDocument()
    expect(screen.getByText("sent during this turn")).toBeInTheDocument()
    expect(screen.getByText("Then add tests")).toBeInTheDocument()
    expect(screen.getByText("queued for the next turn")).toBeInTheDocument()
    expect(screen.getByText("retry cancelled; prior delivery may already have succeeded")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit queued message" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel queued message" })).toBeInTheDocument()

    view.rerender(
      <QueryClientProvider client={client}>
        <Conversation task={{ ...task, archived: true }} stream={initialStreamState} />
      </QueryClientProvider>,
    )
    expect(screen.getAllByText("not delivered; task is archived")).toHaveLength(2)
    expect(screen.queryByRole("button", { name: "Edit queued message" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Cancel queued message" })).toBeNull()
  })
})
