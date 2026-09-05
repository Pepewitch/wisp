import { QueryClient } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import type { DaemonTransport } from "@/lib/transport"
import type { PullRequestInfo, PullRequestStatus } from "@/lib/types"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

import {
  PULL_REQUEST_OVERVIEW_POLL_MS,
  PULL_REQUEST_POLL_MS,
  pullRequestPollInterval,
  usePullRequestOverview,
  usePullRequestStatus,
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

describe("pullRequestPollInterval", () => {
  it.each<PullRequestStatus | undefined>([
    undefined,
    { kind: "none", provider: "github" },
    { kind: "unavailable", provider: "github" },
    { kind: "found", provider: "github", pullRequest: PR },
  ])("keeps watching a status that can still change", (status) => {
    expect(pullRequestPollInterval(status)).toBe(PULL_REQUEST_POLL_MS)
  })

  it.each<PullRequestStatus>([
    { kind: "unsupported", provider: null },
    { kind: "found", provider: "github", pullRequest: { ...PR, lifecycle: "merged" } },
    { kind: "found", provider: "github", pullRequest: { ...PR, lifecycle: "closed" } },
  ])("stops for unsupported origins and terminal PRs", (status) => {
    expect(pullRequestPollInterval(status)).toBe(false)
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

  it("keeps duplicate task IDs under different connection cache keys", async () => {
    mocks.request.mockReset()
    mocks.request.mockResolvedValue({ id: "duplicate-task", title: "Remote task" })
    const { client, wrapper } = harness("connection-two")
    renderHook(() => usePullRequestStatus("duplicate-task"), { wrapper })
    await waitFor(() => expect(mocks.request).toHaveBeenCalled())

    expect(client.getQueryCache().getAll()[0]?.queryKey[0]).toBe("connection-two")
  })
})
