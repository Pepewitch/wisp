import { render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { sameOriginWebTransport } from "@/lib/web-transport"
import type { ConversationDetail } from "@/lib/types"
import { runtimeWrapper } from "@/test/runtime"
import { initialStreamState } from "@/stream/reducer"
import { Conversation } from "./conversation"

afterEach(() => vi.restoreAllMocks())

function archivedTask(): ConversationDetail {
  return {
    id: "tretained", title: "Archived conversation", repo_path: "/synthetic/repo",
    worktree_path: null, branch: null, base_commit: null, harness: "fake", model: null,
    effort: null, slot: 1, state: "done", state_detail: null, session_id: null,
    seq: 1, turn_count: 1, archived: true, attachmentsRetained: true, mode: "worktree",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    messages: [],
    turns: [{
      id: 1, task_id: "tretained", n: 1, prompt: "Keep the prompt",
      result: "Keep the final answer", status: "done", model: null, usage: null,
      capture_mode: null, capture_state: "evicted", captured_bytes: 0,
      capture_detail: "Transcript evicted by archived-task log retention.",
      attachments: [], log_file: "/synthetic/log", started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:01:00Z",
    }],
  }
}

function compactionTask(status: "running" | "done"): ConversationDetail {
  const task = archivedTask()
  return {
    ...task, id: "tcompact", archived: false, state: status,
    state_detail: status === "running" ? "turn 1" : "finished",
    turns: [{
      ...task.turns[0]!, task_id: "tcompact", prompt: "/compact",
      operation: "compact", result: null, status, capture_state: "complete",
      capture_detail: null,
      ended_at: status === "done" ? "2026-01-01T00:01:00Z" : null,
    }],
  }
}

it.each(["browser", "desktop"] as const)("names evicted activity through the %s transport without requesting a lost log", async (runtime) => {
  const payload = archivedTask()
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload)))
  const transport = runtime === "browser" ? sameOriginWebTransport
    : createDesktopTransport("http://127.0.0.1:45123/synthetic-capability/", "remote-one", 7)
  const task = await transport.request<ConversationDetail>("/api/tasks/tretained/conversation")
  const openStream = vi.fn(transport.openEventStream)
  render(<Conversation task={task} stream={initialStreamState} />, { wrapper: runtimeWrapper({ ...transport, openEventStream: openStream }) })
  expect(screen.getByText(/Transcript evicted by archived-task log retention/)).toBeInTheDocument()
  expect(screen.getByText("Keep the prompt")).toBeInTheDocument()
  expect(screen.getByText("Keep the final answer")).toBeInTheDocument()
  expect(screen.queryByText("No activity in this turn")).not.toBeInTheDocument()
  expect(screen.queryByText("Show activity")).not.toBeInTheDocument()
  expect(openStream).not.toHaveBeenCalled()
  expect(String(fetch.mock.calls[0]?.[0])).toBe(runtime === "browser" ? "/api/tasks/tretained/conversation"
    : "http://127.0.0.1:45123/synthetic-capability/connections/remote-one/7/api/tasks/tretained/conversation")
})

it.each(["browser", "desktop"] as const)("renders the prompt-compaction lifecycle in the shared %s UI", (runtime) => {
  const transport = runtime === "browser" ? sameOriginWebTransport
    : createDesktopTransport("http://127.0.0.1:45123/synthetic-capability/", "remote-one", 7)
  const view = render(<Conversation task={compactionTask("running")} stream={initialStreamState} />, {
    wrapper: runtimeWrapper(transport),
  })
  expect(screen.getByTestId("turn-operation-status")).toHaveTextContent("compacting the session…")
  expect(screen.queryByText("Working…")).not.toBeInTheDocument()
  expect(screen.queryByText("No activity in this turn")).not.toBeInTheDocument()

  view.rerender(<Conversation task={compactionTask("done")} stream={initialStreamState} />)
  expect(screen.getByTestId("turn-operation-status")).toHaveTextContent("compacted")
  expect(screen.queryByText("Show activity")).not.toBeInTheDocument()
})
