import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { utcIso } from "@/lib/time"
import type { ActivityEvent, TaskDetail, TaskMessage } from "@/lib/types"
import { initialStreamState, streamReducer, type StreamState } from "@/stream/reducer"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

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
          capture_mode: "recorder-v1",
          capture_state: "degraded",
          captured_bytes: 5_000_000,
          omitted_bytes: 2_048,
          omitted_records: 12,
          capture_categories: null,
          capture_detail: "primary transcript budget reached",
          diagnostic_state: "complete",
          diagnostic_bytes: 10_240,
          diagnostic_first_seq: 1,
          diagnostic_last_seq: 20,
          diagnostic_detail: null,
          diagnostic_evicted_at: null,
          attachments: [],
          log_file: "/tmp/turn.log",
          started_at: "2026-09-03T00:00:00Z",
          ended_at: "2026-09-03T00:00:01Z",
        },
      ],
    } as TaskDetail

    render(<Conversation task={task} stream={initialStreamState} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport()),
    })

    const viewport = screen.getByTestId("conversation-viewport")
    expect(viewport.firstElementChild).toHaveClass("pt-6")
    expect(viewport.querySelector("[data-turn='1']")).not.toHaveClass("pt-2")
    expect(screen.getByText("Activity history incomplete")).toBeInTheDocument()
    expect(screen.getByText(/12 records \(2 KB\) were not retained/)).toBeInTheDocument()
    expect(screen.getByText(/wisp log tspace 1 --diagnostic/)).toBeInTheDocument()
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

    const view = render(<Conversation task={task} stream={initialStreamState} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(), client),
    })

    expect(screen.getByText("Use the safer approach")).toBeInTheDocument()
    expect(screen.getByText(/retried after an unconfirmed delivery/)).toBeInTheDocument()
    expect(screen.getByText("sent during this turn")).toBeInTheDocument()
    expect(screen.getByText("Then add tests")).toBeInTheDocument()
    expect(screen.getByText("queued for the next turn")).toBeInTheDocument()
    expect(screen.getByText("retry cancelled; prior delivery may already have succeeded")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit queued message" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel queued message" })).toBeInTheDocument()

    view.rerender(<Conversation task={{ ...task, archived: true }} stream={initialStreamState} />)
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
    return render(<Conversation task={detail} stream={stream} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(), client),
    })
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

describe("when a user bubble was sent", () => {
  const MINUTE = 60_000
  const DAY = 24 * 60 * MINUTE
  // Half-units keep the assertions clear of a bucket boundary: a test that
  // takes a second to run must not fall out of "5 min ago".
  const first = new Date(Date.now() - (2 * DAY + 12 * 60 * MINUTE)).toISOString()
  const second = new Date(Date.now() - 5.5 * MINUTE).toISOString()
  const steered = new Date(Date.now() - 90.5 * MINUTE).toISOString()

  const message: TaskMessage = {
    id: "mfaketestid03",
    task_id: "tclock",
    text: "Use the safer approach",
    status: "delivered",
    delivery: "steered",
    turn_n: 2,
    delivery_uncertain: false,
    attachments: [],
    created_at: steered,
    updated_at: steered,
  }

  const turn = (n: number, startedAt: string) => ({
    id: n,
    task_id: "tclock",
    n,
    prompt: `Prompt ${n}`,
    result: null,
    status: "running",
    model: "fake-model",
    usage: null,
    attachments: [],
    log_file: "/tmp/turn.log",
    started_at: startedAt,
    ended_at: null,
  })

  const task = {
    id: "tclock",
    title: "Say when each bubble was sent",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/worktree",
    branch: "wisp/tclock",
    base_commit: "abc123",
    harness: "claude-code",
    model: "fake-model",
    effort: null,
    slot: 0,
    state: "running",
    state_detail: "turn 2",
    session_id: "session-1",
    seq: 2,
    turn_count: 2,
    archived: false,
    mode: "worktree",
    created_at: first,
    updated_at: second,
    diffstat: null,
    worktreeReason: null,
    turns: [turn(1, first), turn(2, second)],
    messages: [message],
  } as unknown as TaskDetail

  const render1 = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(<Conversation task={task} stream={initialStreamState} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(), client),
    })
  }

  it("gives every prompt and steer bubble its own relative timestamp", () => {
    render1()

    expect(screen.getByText("2d ago")).toBeInTheDocument()
    expect(screen.getByText("5 min ago")).toBeInTheDocument()
    expect(screen.getByText("1h ago")).toBeInTheDocument()
    const viewport = screen.getByTestId("conversation-viewport")
    expect(viewport.querySelectorAll("[data-bubble-timestamp]")).toHaveLength(3)
  })

  it("swaps the clicked bubble alone to a static UTC instant, and back", () => {
    render1()

    const relative = screen.getByText("5 min ago")
    fireEvent.click(relative)

    expect(relative).toHaveTextContent(utcIso(second))
    expect(relative).toHaveClass("font-mono")
    // its neighbours are untouched — this is a question, not a mode
    expect(screen.getByText("2d ago")).toBeInTheDocument()
    expect(screen.getByText("1h ago")).toBeInTheDocument()

    fireEvent.click(relative)
    expect(relative).toHaveTextContent("5 min ago")
  })
})

describe("copying user messages", () => {
  let restoreClipboard: (() => void) | undefined

  afterEach(() => {
    restoreClipboard?.()
    restoreClipboard = undefined
  })

  it("copies prompt, steered, and queued message text from their bubbles", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    restoreClipboard = () => {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    const task = {
      id: "tcopy",
      title: "Copy messages",
      repo_path: "/tmp/repo",
      worktree_path: "/tmp/worktree",
      branch: "wisp/tcopy",
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
      updated_at: "2026-09-03T00:00:02Z",
      diffstat: null,
      worktreeReason: null,
      turns: [
        {
          id: 1,
          task_id: "tcopy",
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
          id: "m-steered",
          task_id: "tcopy",
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
          task_id: "tcopy",
          text: "Then add tests",
          status: "queued",
          delivery: null,
          turn_n: null,
          delivery_uncertain: false,
          attachments: [],
          created_at: "2026-09-03T00:00:02Z",
          updated_at: "2026-09-03T00:00:02Z",
        },
      ],
    } as TaskDetail
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

    render(<Conversation task={task} stream={initialStreamState} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(), client),
    })

    const buttons = screen.getAllByRole("button", { name: "Copy user message" })
    expect(buttons).toHaveLength(3)

    fireEvent.click(buttons[0]!)
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Original request"))
    expect(screen.getByRole("button", { name: "Copied user message" })).toBeInTheDocument()

    fireEvent.click(buttons[1]!)
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Use the safer approach"))

    fireEvent.click(buttons[2]!)
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Then add tests"))
  })
})

describe("the bubble's caption", () => {
  const base = {
    id: "tcap",
    title: "Captions",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/worktree",
    branch: "wisp/tcap",
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
    updated_at: "2026-09-03T00:00:02Z",
    diffstat: null,
    worktreeReason: null,
    turns: [
      {
        id: 1,
        task_id: "tcap",
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
        id: "m-queued",
        task_id: "tcap",
        text: "Then add tests",
        status: "queued",
        delivery: null,
        turn_n: null,
        delivery_uncertain: false,
        attachments: [],
        created_at: "2026-09-03T00:00:02Z",
        updated_at: "2026-09-03T00:00:02Z",
      },
    ],
  } as unknown as TaskDetail

  const mount = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(<Conversation task={base} stream={initialStreamState} />, {
      wrapper: runtimeWrapper(fakeDaemonTransport(), client),
    })
  }

  /** The card carrying the bubble's own fill, for a given piece of its text. */
  const cardFor = (text: string): HTMLElement => screen.getByText(text).closest(".bg-card") as HTMLElement

  it("hangs a prompt's time and copy control outside the card", () => {
    mount()

    const card = cardFor("Original request")
    const article = card.closest("article")!
    expect(card).toHaveTextContent("Original request")
    // both are in the turn, and neither is in the card
    expect(article.querySelectorAll("[data-bubble-timestamp]")).toHaveLength(1)
    expect(card.querySelector("[data-bubble-timestamp]")).toBeNull()
    expect(card.contains(screen.getAllByRole("button", { name: "Copy user message" })[0]!)).toBe(false)
  })

  it("hangs a queued message's edit and cancel there too, and gives it no time", () => {
    mount()

    const card = cardFor("Then add tests")
    const edit = screen.getByRole("button", { name: "Edit queued message" })
    const cancel = screen.getByRole("button", { name: "Cancel queued message" })
    expect(card.contains(edit)).toBe(false)
    expect(card.contains(cancel)).toBe(false)
    // it has not been sent; the line inside already says the truer thing
    expect(card).toHaveTextContent("queued for the next turn")
    expect(card.closest("article")!.querySelectorAll("[data-bubble-timestamp]")).toHaveLength(0)
  })

  it("brings Save and Cancel back inside while the bubble is a form", () => {
    mount()

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }))

    const card = screen.getByRole("textbox").closest(".bg-card") as HTMLElement
    expect(card).toContainElement(screen.getByRole("button", { name: "Save" }))
    expect(card).toContainElement(screen.getByRole("button", { name: "Cancel" }))
    // the caption empties: only the prompt bubble above still offers copy
    expect(screen.getAllByRole("button", { name: "Copy user message" })).toHaveLength(1)
  })
})
