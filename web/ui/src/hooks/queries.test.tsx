import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PullRequestInfo, PullRequestStatus } from "@/lib/types"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock("@/lib/api", () => ({ api: mocks.api }))

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

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}

describe("usePullRequestStatus", () => {
  beforeEach(() => {
    mocks.api.mockReset()
    mocks.api.mockResolvedValue({ kind: "none", provider: "github" })
  })

  it("reads only the selected task endpoint", async () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestStatus("tpr01"), { wrapper })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/tasks/tpr01/pull-request"))
  })

  it("does not read when no task is selected", () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestStatus(null), { wrapper })
    expect(mocks.api).not.toHaveBeenCalled()
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
    mocks.api.mockReset()
    mocks.api.mockResolvedValue({ tasks: {} })
  })

  it("reads one batched endpoint for all live sidebar rows", async () => {
    const { wrapper } = harness()
    renderHook(() => usePullRequestOverview(), { wrapper })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/pull-requests"))
  })

  it("refreshes at the bounded one-minute overview interval", () => {
    expect(PULL_REQUEST_OVERVIEW_POLL_MS).toBe(60_000)
  })
})

describe("useUpdateStatus", () => {
  it("reads the daemon-cached update endpoint", async () => {
    mocks.api.mockReset()
    mocks.api.mockResolvedValue({
      currentVersion: "0.4.0-alpha.6",
      latestVersion: null,
      state: "up-to-date",
    })
    const { wrapper } = harness()
    renderHook(() => useUpdateStatus(), { wrapper })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/update"))
  })
})
