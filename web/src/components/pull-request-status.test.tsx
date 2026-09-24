import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import type { AutopilotStatus } from "../../../shared/autopilot"
import type { PullRequestInfo, PullRequestStatus } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { MobileShell } from "./mobile-shell"
import { PullRequestStatusLink } from "./pull-request-status"
import { TaskHeader } from "./task-header"

const FOUND: PullRequestStatus = {
  kind: "found",
  provider: "github",
  pullRequest: {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Show pull request status",
    lifecycle: "open",
    queuedToMerge: false,
    checks: "failed",
    review: "changes-requested",
    mergeState: "blocked",
    updatedAt: "2026-09-04T12:00:00Z",
  },
}

function withClient(node: ReactNode) {
  return render(node, { wrapper: runtimeWrapper(fakeDaemonTransport()) })
}

describe("PullRequestStatusLink", () => {
  it("renders lifecycle, CI, and review as one unboxed external link", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} />)

    const link = screen.getByRole("link", {
      name: "PR #42 · Open · CI failed · Changes requested · Merge blocked: Show pull request status",
    })
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveTextContent("PR #42 · Open · CI failed · Changes requested")
    expect(link.className).not.toContain("rounded-full")
    expect(link.className).not.toContain("border")
  })

  it("says it is the newest when the task made more than one", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} others={2} />)

    // the row shows ONE pull request, so the count is the only thing that
    // would otherwise be hidden — one short fact, muted, no box
    const link = screen.getByRole("link", {
      name: "PR #42 · Open · CI failed · Changes requested · newest of 3 on this task · Merge blocked: Show pull request status",
    })
    expect(link).toHaveTextContent("+2")
  })

  it("says nothing at all when it is the only one", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} />)

    expect(screen.queryByTestId("pull-request-others")).toBeNull()
    expect(screen.getByRole("link", { name: /PR #42/ }).textContent).not.toContain("+")
  })

  it.each<{
    label: string
    overrides: Partial<PullRequestInfo>
    tone: string
  }>([
    {
      label: "orange while queued to merge",
      overrides: { queuedToMerge: true, checks: "passed", review: "approved", mergeState: "ready" },
      tone: "text-merge-queue",
    },
    {
      label: "green when every merge requirement passes",
      overrides: { checks: "passed", review: "approved", mergeState: "ready" },
      tone: "text-state-done",
    },
    {
      label: "yellow when GitHub allows merging despite failed CI",
      overrides: { checks: "failed", review: "approved", mergeState: "unstable" },
      tone: "text-state-needs-input",
    },
    {
      label: "red when a repository rule blocks merging",
      overrides: { checks: "passed", review: "required", mergeState: "blocked" },
      tone: "text-destructive",
    },
    {
      label: "purple after the PR is merged",
      overrides: { lifecycle: "merged", checks: "passed", review: "approved" },
      tone: "text-primary",
    },
    {
      label: "muted while required CI is pending",
      overrides: { checks: "pending", review: "approved", mergeState: "blocked" },
      tone: "text-muted-foreground",
    },
  ])("$label", ({ overrides, tone }) => {
    render(<PullRequestStatusLink pullRequest={{ ...FOUND.pullRequest, ...overrides }} />)
    expect(screen.getByTestId("pull-request-icon")).toHaveClass(tone)
  })

  it("replaces the open lifecycle with the queued-to-merge status", () => {
    render(<PullRequestStatusLink pullRequest={{ ...FOUND.pullRequest, queuedToMerge: true }} />)

    const link = screen.getByTestId("pull-request-status")
    expect(link).toHaveTextContent("PR #42 · Queued to merge · CI failed · Changes requested")
    expect(link).not.toHaveTextContent("PR #42 · Open")
  })

  it("keeps all three facts in the mobile two-line target", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} compact />)
    const link = screen.getByTestId("pull-request-status")
    expect(link).toHaveTextContent("PR #42 · Open")
    expect(link).toHaveTextContent("CI failed · Changes requested")
    expect(link).toHaveClass("h-11")
  })
})

describe("PR status in task headers", () => {
  it("replaces the desktop Push button only when a PR was found", () => {
    withClient(<TaskHeader task={TASKS[0]!} pullRequest={FOUND} />)
    expect(screen.getByTestId("pull-request-status")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /push/i })).toBeNull()
  })

  it.each([
    { kind: "none", provider: "github" } as const,
    { kind: "unsupported", provider: null } as const,
    { kind: "unavailable", provider: "github" } as const,
  ])("shows nothing for $kind", (pullRequest) => {
    const { container } = withClient(<TaskHeader task={TASKS[0]!} pullRequest={pullRequest} />)
    expect(screen.queryByTestId("pull-request-status")).toBeNull()
    expect(container.textContent).not.toContain("Push")
  })

  it("replaces the mobile Push button with the compact PR link", () => {
    withClient(
      <MobileShell
        task={TASKS[0]!}
        pullRequest={FOUND}
        sidebar={() => null}
        conversation={<div />}
        changes={<div />}
        terminal={<div />}
        composer={<div />}
      />,
    )
    expect(screen.getByTestId("pull-request-status")).toHaveClass("h-11")
    expect(screen.queryByRole("button", { name: /push/i })).toBeNull()
  })
})

describe("the auto-merge reason on the PR line", () => {
  const status = (over: Partial<AutopilotStatus> = {}): AutopilotStatus => ({
    autoMerge: true, autoFix: false, pr: 42, state: "waiting", reason: "Waiting for checks (2 running)",
    about: "pr", by: "auto-merge", mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null, ...over,
  })

  it("stands in for CI and review while armed, and the hover still carries both", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status()} />)
    const link = screen.getByRole("link", { name: /Auto-merge: Waiting for checks \(2 running\)/ })
    expect(link).toHaveTextContent("PR #42 · Open · Auto-merge: Waiting for checks (2 running)")
    expect(link).not.toHaveTextContent("CI failed")
    expect(link.getAttribute("title")).toContain("CI failed · Changes requested")
  })

  it("says when it is paused on this PR", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ state: "paused", reason: "Merge failed: conflict" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("Auto-merge paused: Merge failed: conflict")
  })

  it("never hides this PR's CI and review behind a reason about the task, another PR, or no PR at all", () => {
    const cases = [
      status({ about: "task", reason: "Waiting for the task to finish" }),
      status({ pr: 7, reason: "test failed" }),
      status({ pr: null, about: "task", reason: "Waiting for a PR" }),
    ]
    for (const autoMerge of cases) {
      const { unmount } = render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={autoMerge} />)
      const link = screen.getByRole("link")
      expect(link).toHaveTextContent("CI failed · Changes requested")
      // the reason is still there, in the hover
      expect(link.getAttribute("title")).toContain(autoMerge.reason)
      unmount()
    }
  })

  it("does not repeat a merge queue the lifecycle already names", () => {
    render(<PullRequestStatusLink pullRequest={{ ...FOUND.pullRequest, queuedToMerge: true }} autoMerge={status({ state: "queued", reason: "Queued to merge" })} />)
    expect(screen.getByRole("link")).not.toHaveTextContent("Auto-merge")
  })

  it("says the merge was Wisp's, and stays out of the way when auto-merge is off", () => {
    const merged = { ...FOUND.pullRequest, lifecycle: "merged" as const }
    const { unmount } = render(<PullRequestStatusLink pullRequest={merged} autoMerge={status({ autoMerge: false, state: "merged", reason: "Merged by Wisp", mergedByWisp: true })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Merged by Wisp")
    unmount()
    // someone else merged it: the provider's word stands
    const other = render(<PullRequestStatusLink pullRequest={merged} autoMerge={status({ autoMerge: false, state: "merged", reason: "#42 was merged" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Merged · ")
    other.unmount()
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ autoMerge: false, state: "off", reason: "Auto-merge off" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("CI failed · Changes requested")
  })

  it("still says Wisp merged it while the switch stays on for the task's next PR", () => {
    const merged = { ...FOUND.pullRequest, lifecycle: "merged" as const }
    const staying = status({ pr: null, state: "waiting", reason: "#42 merged by Wisp · Waiting for the task's next PR", about: "task", lastMerged: { pr: 42, byWisp: true } })
    const { unmount } = render(<PullRequestStatusLink pullRequest={merged} autoMerge={staying} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Merged by Wisp")
    unmount()
    // a merge that was not Wisp's, or of another PR, is the provider's word
    render(<PullRequestStatusLink pullRequest={merged} autoMerge={{ ...staying, lastMerged: { pr: 41, byWisp: true } }} />)
    expect(screen.getByRole("link")).not.toHaveTextContent("Merged by Wisp")
  })

  it("names the switch whose reason it is, without saying it twice", () => {
    const fixing = { autoFix: true, by: "auto-fix" } as const
    const { unmount } = render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ ...fixing, reason: "Auto-fix will send: test failing" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Open · Auto-fix will send: test failing")
    unmount()
    // both on: auto-fix's rerun is auto-fix's to explain, the gate's wait is auto-merge's
    const rerun = render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ ...fixing, reason: "Rerunning test" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Open · Auto-fix: Rerunning test")
    rerun.unmount()
    const review = render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ autoFix: true, reason: "Waiting for a review" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Open · Auto-merge: Waiting for a review")
    review.unmount()
    // a pause that already names its switch is not prefixed with it again
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status({ ...fixing, state: "paused", reason: "Auto-fix gave up after 3 rounds — resume to try again" })} />)
    expect(screen.getByRole("link")).toHaveTextContent("PR #42 · Open · Auto-fix gave up after 3 rounds — resume to try again")
    expect(screen.getByRole("link")).not.toHaveTextContent("Auto-fix paused")
  })

  it("uses the compact link's second line for the reason on mobile", () => {
    render(<PullRequestStatusLink pullRequest={FOUND.pullRequest} autoMerge={status()} compact />)
    expect(screen.getByText("Auto-merge: Waiting for checks (2 running)")).toBeInTheDocument()
  })
})
