import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import type { ActivityEvent, TaskDetail, TaskMessage } from "@/lib/types"
import { initialStreamState, streamReducer, type StreamState } from "@/stream/reducer"

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

describe("a steer that lands inside a running turn", () => {
  const message: TaskMessage = {
    id: "mfaketestid01",
    task_id: "tsteer",
    text: "Use the safer approach",
    status: "delivered",
    delivery: "steered",
    turn_n: 1,
    delivery_uncertain: false,
    attachments: [],
    created_at: "2026-09-03T00:00:01Z",
    updated_at: "2026-09-03T00:00:01Z",
  }

  const task = {
    id: "tsteer",
    title: "Place a steer where it landed",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/worktree",
    branch: "wisp/tsteer",
    base_commit: "abc123",
    harness: "claude-code",
    model: "fake-model",
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
    updated_at: "2026-09-03T00:00:02Z",
    diffstat: null,
    worktreeReason: null,
    turns: [
      {
        id: 1,
        task_id: "tsteer",
        n: 1,
        prompt: "Original request",
        result: null,
        status: "running",
        model: "fake-model",
        usage: null,
        attachments: [],
        log_file: "/tmp/turn.log",
        started_at: "2026-09-03T00:00:00Z",
        ended_at: null,
      },
    ],
    messages: [message],
  } as TaskDetail

  const streamOf = (activity: ActivityEvent[]): StreamState =>
    streamReducer(initialStreamState, { type: "backlog", turn: 1, prompt: "Original request", activity })

  const anchored = streamOf([
    { kind: "text", id: "t1", parentId: null, text: "Reading the config" },
    { kind: "message", id: message.id, parentId: null, text: "Use the safer approach" },
    { kind: "text", id: "t2", parentId: null, text: "Switching approach" },
  ])

  const render1 = (stream: StreamState, detail: TaskDetail = task) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <Conversation task={detail} stream={stream} />
      </QueryClientProvider>,
    )
  }

  const orderIn = (text: string, ...needles: string[]) => needles.map((needle) => text.indexOf(needle))

  it("renders between the activity before it and the activity after it", () => {
    render1(anchored)

    const article = screen.getByTestId("conversation-viewport").querySelector("[data-turn='1']")!
    const [prompt, before, steer, after] = orderIn(
      article.textContent ?? "",
      "Original request",
      "Reading the config",
      "Use the safer approach",
      "Switching approach",
    )
    expect(prompt).toBeGreaterThanOrEqual(0)
    expect(before).toBeGreaterThan(prompt!)
    expect(steer).toBeGreaterThan(before!)
    expect(after).toBeGreaterThan(steer!)
    expect(article.querySelectorAll("[data-steered-message]")).toHaveLength(1)
    expect(screen.getByText("sent during this turn")).toBeInTheDocument()
  })

  it("falls back to the head of the turn when the timeline carries no anchor", () => {
    render1(
      streamOf([
        { kind: "text", id: "t1", parentId: null, text: "Reading the config" },
        { kind: "text", id: "t2", parentId: null, text: "Switching approach" },
      ]),
    )

    const article = screen.getByTestId("conversation-viewport").querySelector("[data-turn='1']")!
    const [prompt, steer, before] = orderIn(
      article.textContent ?? "",
      "Original request",
      "Use the safer approach",
      "Reading the config",
    )
    expect(steer).toBeGreaterThan(prompt!)
    expect(before).toBeGreaterThan(steer!)
    expect(article.querySelectorAll("[data-steered-message]")).toHaveLength(1)
  })

  it("leaves a queued message queued even when the log anchored an earlier attempt", () => {
    const queued: TaskMessage = { ...message, id: "mfaketestid02", status: "queued", delivery: null, turn_n: null }
    render1(streamOf([{ kind: "message", id: queued.id, parentId: null, text: "Use the safer approach" }]), {
      ...task,
      messages: [queued],
    })

    expect(screen.getByText("queued for the next turn")).toBeInTheDocument()
    expect(screen.queryByText("sent during this turn")).toBeNull()
    expect(screen.queryByTestId("conversation-viewport")!.querySelectorAll("[data-steered-message]")).toHaveLength(0)
  })
})
