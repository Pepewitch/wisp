import { render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { sameOriginWebTransport } from "@/lib/web-transport"
import type { TaskDetail } from "@/lib/types"
import { runtimeWrapper } from "@/test/runtime"
import { initialStreamState } from "@/stream/reducer"
import { Conversation } from "./conversation"

afterEach(() => vi.restoreAllMocks())

function archivedTask(): TaskDetail {
  return {
    id: "tretained", title: "Archived conversation", repo_path: "/synthetic/repo",
    worktree_path: null, branch: null, base_commit: null, harness: "fake", model: null,
    effort: null, slot: 1, state: "done", state_detail: null, session_id: null,
    seq: 1, turn_count: 1, archived: true, attachmentsRetained: true, mode: "worktree",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    diffstat: null, worktreeReason: null, messages: [],
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

it.each(["browser", "desktop"] as const)("names evicted activity through the %s transport without requesting a lost log", async (runtime) => {
  const payload = archivedTask()
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload)))
  const transport = runtime === "browser" ? sameOriginWebTransport
    : createDesktopTransport("http://127.0.0.1:45123/synthetic-capability/", "remote-one", 7)
  const task = await transport.request<TaskDetail>("/api/tasks/tretained")
  const openStream = vi.fn(transport.openEventStream)
  render(<Conversation task={task} stream={initialStreamState} />, { wrapper: runtimeWrapper({ ...transport, openEventStream: openStream }) })
  expect(screen.getByText(/Transcript evicted by archived-task log retention/)).toBeInTheDocument()
  expect(screen.getByText("Keep the prompt")).toBeInTheDocument()
  expect(screen.getByText("Keep the final answer")).toBeInTheDocument()
  expect(screen.queryByText("No activity in this turn")).not.toBeInTheDocument()
  expect(screen.queryByText("Show activity")).not.toBeInTheDocument()
  expect(openStream).not.toHaveBeenCalled()
  expect(String(fetch.mock.calls[0]?.[0])).toBe(runtime === "browser" ? "/api/tasks/tretained"
    : "http://127.0.0.1:45123/synthetic-capability/connections/remote-one/7/api/tasks/tretained")
})
