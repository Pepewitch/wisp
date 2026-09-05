import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
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

  it.each<{
    label: string
    overrides: Partial<PullRequestInfo>
    tone: string
  }>([
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
