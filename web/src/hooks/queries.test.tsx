import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import { createConnectionQueryKeys } from "@/lib/query"
import { ApiError, type DaemonTransport } from "@/lib/transport"
import type { PullRequestInfo, PullRequestStatus } from "@/lib/types"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

import {
  PULL_REQUEST_OVERVIEW_POLL_MS,
  PULL_REQUEST_POLL_MS,
  pullRequestPollInterval,
  usePullRequestOverview,
  usePullRequests,
  usePullRequestStatus,
  useTaskDetail,
  useTaskUsage,
  useUpdateStatus,
} from "./queries"

const PR: PullRequestInfo = {
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  title: "Show pull request status",
  lifecycle: "open",
  checks: "pending",
  review: "required",
  mergeState: "blocked",
  updatedAt: "2026-09-04T12:00:00Z",
}

function harness(connectionId = "local") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const transport = fakeDaemonTransport(connectionId, {
    request: mocks.request as DaemonTransport["request"],
  })
  return {
    client,
    wrapper: runtimeWrapper(transport, client),
  }
}

describe("usePullRequestStatus", () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ kind: "none", provider: "github" })
  })

  it("reads only the selected task endpoint", async () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestStatus("tpr01"), { wrapper })
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/api/tasks/tpr01/pull-request"))
  })

  it("does not read when no task is selected", () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestStatus(null), { wrapper })
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

describe("useTaskDetail", () => {
  it("reads the DB-only conversation endpoint for the selected task", async () => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ id: "tdetail" })
    const { wrapper } = harness()
    renderHook(() => useTaskDetail("tdetail"), { wrapper })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "/api/tasks/tdetail/conversation?limit=50"
      )
    )
  })

  it("prepends older pages in turn and message order", async () => {
    mocks.request.mockReset()
    mocks.request
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 51 }, { n: 52 }],
        messages: [{ id: "message-51" }],
        has_older_turns: true,
        older_turns_before: 51,
      })
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 1 }, { n: 2 }],
        messages: [{ id: "message-1" }],
        has_older_turns: false,
        older_turns_before: null,
      })
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tdetail"), { wrapper })
    await waitFor(() => expect(result.result.current.hasOlderTurns).toBe(true))

    await act(async () => {
      await result.result.current.loadOlderTurns()
    })

    expect(mocks.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/tasks/tdetail/conversation?limit=50",
      "/api/tasks/tdetail/conversation?limit=50&before=51",
    ])
    await waitFor(() =>
      expect(result.result.current.data?.turns.map((turn) => turn.n)).toEqual([1, 2, 51, 52]),
    )
    expect(result.result.current.data?.messages?.map((message) => message.id)).toEqual([
      "message-1",
      "message-51",
    ])
    expect(result.result.current.hasOlderTurns).toBe(false)
  })

  it("does not read conversation detail when no task is selected", () => {
    mocks.request.mockReset()
    const { wrapper } = harness()
    renderHook(() => useTaskDetail(null), { wrapper })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("keeps loaded history but replaces the latest page and pending messages on refetch", async () => {
    mocks.request.mockReset()
    mocks.request
      .mockResolvedValueOnce({
        id: "tdetail",
        title: "before",
        turns: [{ n: 51 }, { n: 52 }],
        messages: [
          { id: "message-51", turn_n: 51 },
          { id: "message-queued", turn_n: null, status: "queued" },
        ],
        has_older_turns: true,
        older_turns_before: 51,
      })
      .mockResolvedValueOnce({
        id: "tdetail",
        title: "before",
        turns: [{ n: 1 }],
        messages: [{ id: "message-1", turn_n: 1 }],
        has_older_turns: false,
        older_turns_before: null,
      })
      .mockResolvedValueOnce({
        id: "tdetail",
        title: "after",
        turns: [{ n: 52 }, { n: 53 }],
        messages: [{ id: "message-52", turn_n: 52 }],
        has_older_turns: true,
        older_turns_before: 52,
      })
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tdetail"), { wrapper })
    await waitFor(() => expect(result.result.current.hasOlderTurns).toBe(true))
    await act(async () => {
      await result.result.current.loadOlderTurns()
    })
    await act(async () => {
      await result.result.current.refetch()
    })

    await waitFor(() => expect(result.result.current.data?.title).toBe("after"))
    expect(result.result.current.data?.turns.map((turn) => turn.n)).toEqual([1, 51, 52, 53])
    expect(result.result.current.data?.messages?.map((message) => message.id)).toEqual([
      "message-1",
      "message-51",
      "message-52",
    ])
    expect(result.result.current.hasOlderTurns).toBe(false)
  })

  it("discards an older page if a realtime refresh advances its request cursor", async () => {
    mocks.request.mockReset()
    let resolveOlder!: (page: unknown) => void
    const older = new Promise((resolve) => {
      resolveOlder = resolve
    })
    mocks.request
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 51 }, { n: 52 }],
        messages: [],
        has_older_turns: true,
        older_turns_before: 51,
      })
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 52 }, { n: 53 }],
        messages: [],
        has_older_turns: true,
        older_turns_before: 52,
      })
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tdetail"), { wrapper })
    await waitFor(() => expect(result.result.current.hasOlderTurns).toBe(true))

    const olderRequest = result.result.current.loadOlderTurns()
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
    await act(async () => {
      await result.result.current.refetch()
    })
    await waitFor(() =>
      expect(result.result.current.data?.turns.map((turn) => turn.n)).toEqual([52, 53]),
    )
    resolveOlder({
      id: "tdetail",
      turns: [{ n: 1 }, { n: 50 }],
      messages: [],
      has_older_turns: false,
      older_turns_before: null,
    })
    await act(async () => {
      await olderRequest
    })

    expect(result.result.current.data?.turns.map((turn) => turn.n)).toEqual([52, 53])
    expect(result.result.current.data?.older_turns_before).toBe(52)
  })

  it("rejects an earlier page that does not advance the cursor", async () => {
    mocks.request.mockReset()
    mocks.request
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 51 }],
        messages: [],
        has_older_turns: true,
        older_turns_before: 51,
      })
      .mockResolvedValueOnce({
        id: "tdetail",
        turns: [{ n: 51 }],
        messages: [],
        has_older_turns: true,
        older_turns_before: 51,
      })
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tdetail"), { wrapper })
    await waitFor(() => expect(result.result.current.hasOlderTurns).toBe(true))

    await expect(result.result.current.loadOlderTurns()).rejects.toThrow(
      "invalid earlier-turn page",
    )
    await waitFor(() =>
      expect(result.result.current.olderTurnsError).toBeInstanceOf(Error),
    )
    expect(result.result.current.data?.turns.map((turn) => turn.n)).toEqual([51])
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })

  it("clears an older-page error when the selected task changes", async () => {
    mocks.request.mockReset()
    mocks.request
      .mockResolvedValueOnce({
        id: "task-a",
        turns: [{ n: 51 }],
        messages: [],
        has_older_turns: true,
        older_turns_before: 51,
      })
      .mockRejectedValueOnce(new Error("task A failed"))
      .mockResolvedValueOnce({
        id: "task-b",
        turns: [{ n: 1 }],
        messages: [],
        has_older_turns: false,
        older_turns_before: null,
      })
    const { wrapper } = harness()
    const result = renderHook(({ id }) => useTaskDetail(id), {
      wrapper,
      initialProps: { id: "task-a" },
    })
    await waitFor(() => expect(result.result.current.data?.id).toBe("task-a"))
    await expect(result.result.current.loadOlderTurns()).rejects.toThrow("task A failed")
    await waitFor(() => expect(result.result.current.olderTurnsError).toBeInstanceOf(Error))

    result.rerender({ id: "task-b" })
    await waitFor(() => expect(result.result.current.data?.id).toBe("task-b"))
    await waitFor(() => expect(result.result.current.olderTurnsError).toBeNull())
  })

  it("falls back to legacy detail when a protocol-1 daemon lacks the route", async () => {
    mocks.request.mockReset()
    mocks.request
      .mockRejectedValueOnce(new ApiError("not found", 404))
      .mockResolvedValueOnce({ id: "tlegacy" })
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tlegacy"), { wrapper })

    await waitFor(() => expect(result.result.current.data).toEqual({ id: "tlegacy" }))
    expect(mocks.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/tasks/tlegacy/conversation?limit=50",
      "/api/tasks/tlegacy",
    ])
  })

  it("does not hide a conversation endpoint failure behind legacy Git work", async () => {
    mocks.request.mockReset()
    mocks.request.mockRejectedValue(new ApiError("broken", 500))
    const { wrapper } = harness()
    const result = renderHook(() => useTaskDetail("tbroken"), { wrapper })

    await waitFor(() => expect(result.result.current.error).toMatchObject({ status: 500 }))
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})

describe("useTaskUsage", () => {
  it("reads task-wide telemetry only while the report is open", async () => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ turns: [{ id: 1, n: 1, usage: { inputTokens: 7 } }] })
    const { wrapper } = harness()
    const result = renderHook(
      ({ enabled }) => useTaskUsage("tdetail", enabled),
      { wrapper, initialProps: { enabled: false } },
    )
    expect(mocks.request).not.toHaveBeenCalled()

    result.rerender({ enabled: true })
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("/api/tasks/tdetail/usage"),
    )
    await waitFor(() =>
      expect(result.result.current.data?.turns[0]?.usage).toEqual({ inputTokens: 7 }),
    )
  })
})

describe("pullRequestPollInterval", () => {
  it.each<PullRequestStatus | undefined>([
    undefined,
    { kind: "none", provider: "github" },
    { kind: "unavailable", provider: "github" },
    { kind: "found", provider: "github", pullRequest: PR },
    { kind: "found", provider: "github", pullRequest: { ...PR, lifecycle: "merged" } },
    { kind: "found", provider: "github", pullRequest: { ...PR, lifecycle: "closed" } },
  ])("keeps watching a status that can still change", (status) => {
    expect(pullRequestPollInterval(status)).toBe(PULL_REQUEST_POLL_MS)
  })

  it("stops for unsupported origins", () => {
    expect(pullRequestPollInterval({ kind: "unsupported", provider: null })).toBe(false)
  })
})

describe("usePullRequestOverview", () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ tasks: {} })
  })

  it("reads one batched endpoint for all live sidebar rows", async () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestOverview(), { wrapper })
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/api/pull-requests"))
  })

  it("refreshes at the bounded one-minute overview interval", () => {
    expect(PULL_REQUEST_OVERVIEW_POLL_MS).toBe(60_000)
  })
})

describe("usePullRequests", () => {
  const MERGED: PullRequestStatus = {
    kind: "found",
    provider: "github",
    pullRequest: { ...PR, lifecycle: "merged" },
  }
  const OPEN: PullRequestStatus = { kind: "found", provider: "github", pullRequest: PR }

  beforeEach(() => {
    mocks.request.mockReset()
  })

  it("shows the sidebar and the header the same PR, from whichever answered last", async () => {
    // the overview is a minute behind the per-task poll, which is the whole
    // reason the row said Open while the header said Merged
    mocks.request.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/api/pull-requests"
          ? { tasks: { tpr01: { status: OPEN, checkedAt: "2026-09-04T12:00:00Z", stale: false } } }
          : MERGED,
      ),
    )
    const { wrapper } = harness()
    const { result } = renderHook(() => usePullRequests("tpr01"), { wrapper })
    await waitFor(() => expect(result.current.selected).toEqual(MERGED))
    expect(result.current.tasks.tpr01?.status).toEqual(MERGED)
  })

  it("still serves the sidebar every other live task", async () => {
    mocks.request.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/api/pull-requests"
          ? { tasks: { tpr02: { status: OPEN, checkedAt: "2026-09-04T12:00:00Z", stale: false } } }
          : MERGED,
      ),
    )
    const { wrapper } = harness()
    const { result } = renderHook(() => usePullRequests("tpr01"), { wrapper })
    await waitFor(() => expect(result.current.tasks.tpr02?.status).toEqual(OPEN))
    expect(result.current.tasks.tpr01?.status).toEqual(MERGED)
  })

  it("reads the overview alone when nothing is selected", async () => {
    mocks.request.mockResolvedValue({
      tasks: { tpr02: { status: OPEN, checkedAt: "2026-09-04T12:00:00Z", stale: false } },
    })
    const { wrapper } = harness()
    const { result } = renderHook(() => usePullRequests(null), { wrapper })
    await waitFor(() => expect(result.current.tasks.tpr02?.status).toEqual(OPEN))
    expect(result.current.selected).toBeUndefined()
    expect(mocks.request).not.toHaveBeenCalledWith("/api/tasks/null/pull-request")
  })
})

describe("useUpdateStatus", () => {
  it("reads the daemon-cached update endpoint", async () => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({
      currentVersion: "0.4.0-alpha.6",
      latestVersion: null,
      state: "up-to-date",
    })
    const { wrapper } = harness()
    renderHook(() => useUpdateStatus(), { wrapper })
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/api/update"))
  })

  it("can read an explicit Local target while another connection is active", async () => {
    mocks.request.mockReset()
    const localRequest = vi.fn().mockResolvedValue({
      currentVersion: "0.4.0-alpha.6",
      latestVersion: null,
      state: "up-to-date",
    })
    const local = fakeDaemonTransport("local", {
      request: localRequest as DaemonTransport["request"],
    })
    const { client, wrapper } = harness("saved-remote")

    renderHook(
      () =>
        useUpdateStatus({
          transport: local,
          qk: createConnectionQueryKeys(local.connectionId),
        }),
      { wrapper },
    )

    await waitFor(() => expect(localRequest).toHaveBeenCalledWith("/api/update"))
    expect(mocks.request).not.toHaveBeenCalled()
    expect(client.getQueryCache().getAll()[0]?.queryKey[0]).toBe("local")
  })

  it("keeps duplicate task IDs under different connection cache keys", async () => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ id: "duplicate-task", title: "Remote task" })
    const { client, wrapper } = harness("connection-two")
    renderHook(() => usePullRequestStatus("duplicate-task"), { wrapper })
    await waitFor(() => expect(mocks.request).toHaveBeenCalled())

    expect(client.getQueryCache().getAll()[0]?.queryKey[0]).toBe("connection-two")
  })
})
