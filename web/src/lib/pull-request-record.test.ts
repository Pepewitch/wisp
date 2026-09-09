import { describe, expect, it } from "vitest"

import { reconcilePullRequests } from "./pull-request-record"
import type {
  PullRequestInfo,
  PullRequestOverviewEntry,
  PullRequestStatus,
} from "@/lib/types"

const PR: PullRequestInfo = {
  number: 111,
  url: "https://github.com/acme/widgets/pull/111",
  title: "Add post-creation harness switching",
  lifecycle: "open",
  checks: "pending",
  review: "none",
  mergeState: "blocked",
  updatedAt: "2026-09-09T11:00:00Z",
}

const found = (lifecycle: PullRequestInfo["lifecycle"]): PullRequestStatus => ({
  kind: "found",
  provider: "github",
  pullRequest: { ...PR, lifecycle },
})

// the per-task poll answered after the overview did, which is the ordinary case
const AT = {
  selected: Date.parse("2026-09-09T12:00:00Z"),
  overview: Date.parse("2026-09-09T11:59:05Z"),
}

function overview(status: PullRequestStatus, stale = false) {
  return {
    t1: {
      status,
      checkedAt: "2026-09-09T11:59:00Z",
      stale,
    } satisfies PullRequestOverviewEntry,
  }
}

describe("reconcilePullRequests", () => {
  it("gives the sidebar the merge the header just learned about", () => {
    const tasks = reconcilePullRequests(
      overview(found("open")),
      "t1",
      found("merged"),
      AT,
    )
    // the reported bug: header purple, row gray, for a whole overview interval
    expect(tasks.t1?.status).toEqual(found("merged"))
    expect(tasks.t1?.stale).toBe(false)
    expect(tasks.t1?.checkedAt).toBe("2026-09-09T12:00:00.000Z")
  })

  it("leaves every other task's entry exactly as the overview served it", () => {
    const before = {
      ...overview(found("open")),
      t2: {
        status: found("closed"),
        checkedAt: "2026-09-09T11:59:00Z",
        stale: true,
      },
    }
    const tasks = reconcilePullRequests(before, "t1", found("merged"), AT)
    expect(tasks.t2).toBe(before.t2)
  })

  it("carries the selected task through before the overview has answered", () => {
    const tasks = reconcilePullRequests(undefined, "t1", found("merged"), AT)
    expect(tasks.t1?.status).toEqual(found("merged"))
  })

  it("keeps the overview untouched when nothing is selected", () => {
    const before = overview(found("open"))
    expect(reconcilePullRequests(before, null, found("merged"), AT)).toBe(before)
  })

  it("keeps the overview untouched while the selected task is still loading", () => {
    const before = overview(found("open"))
    expect(reconcilePullRequests(before, "t1", undefined, AT)).toBe(before)
  })

  it("never lets a failed provider call erase what the row already knows", () => {
    const tasks = reconcilePullRequests(
      overview(found("merged")),
      "t1",
      { kind: "unavailable", provider: "github" },
      AT,
    )
    expect(tasks.t1?.status).toEqual(found("merged"))
    expect(tasks.t1?.stale).toBe(true)
    // the last real answer keeps its own timestamp: nothing was checked now
    expect(tasks.t1?.checkedAt).toBe("2026-09-09T11:59:00Z")
  })

  it("does not churn the entry when the failure repeats", () => {
    const before = overview(found("merged"), true)
    const tasks = reconcilePullRequests(
      before,
      "t1",
      { kind: "unavailable", provider: "github" },
      AT,
    )
    expect(tasks.t1).toBe(before.t1)
  })

  it("reports an unavailable it has no better answer than", () => {
    const tasks = reconcilePullRequests(
      undefined,
      "t1",
      { kind: "unavailable", provider: null },
      AT,
    )
    expect(tasks.t1?.status).toEqual({ kind: "unavailable", provider: null })
    expect(tasks.t1?.stale).toBe(false)
  })

  it("yields to an overview that landed after the per-task poll", () => {
    // the daemon shares its answers between the two endpoints, so the later
    // response is the better one no matter which endpoint served it
    const before = overview(found("merged"))
    const tasks = reconcilePullRequests(before, "t1", found("open"), {
      selected: Date.parse("2026-09-09T11:59:00Z"),
      overview: Date.parse("2026-09-09T12:00:00Z"),
    })
    expect(tasks).toBe(before)
  })

  it("still adopts a task the overview has never carried", () => {
    const tasks = reconcilePullRequests({}, "t1", found("merged"), {
      selected: Date.parse("2026-09-09T11:59:00Z"),
      overview: Date.parse("2026-09-09T12:00:00Z"),
    })
    expect(tasks.t1?.status).toEqual(found("merged"))
  })

  it("lets a task that lost its PR say so", () => {
    const tasks = reconcilePullRequests(
      overview(found("open")),
      "t1",
      { kind: "none", provider: "github" },
      AT,
    )
    expect(tasks.t1?.status).toEqual({ kind: "none", provider: "github" })
  })
})
