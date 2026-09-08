import type { PullRequestInfo } from "@/lib/types"

export const PULL_REQUEST_ICON_TONE = {
  muted: "text-muted-foreground",
  ready: "text-state-done",
  warning: "text-state-needs-input",
  blocked: "text-destructive",
  merged: "text-primary",
} as const

export function pullRequestIconTone(
  pullRequest: PullRequestInfo,
): keyof typeof PULL_REQUEST_ICON_TONE {
  if (pullRequest.lifecycle === "merged") return "merged"
  if (pullRequest.lifecycle !== "open") return "muted"
  if (
    pullRequest.review === "required" ||
    pullRequest.review === "changes-requested"
  ) {
    return "blocked"
  }
  if (
    pullRequest.mergeState === "behind" ||
    pullRequest.mergeState === "conflicting"
  ) {
    return "blocked"
  }
  if (pullRequest.checks === "pending") return "muted"
  if (pullRequest.mergeState === "blocked") return "blocked"
  if (
    pullRequest.mergeState === "unstable" &&
    pullRequest.checks === "failed"
  ) {
    return "warning"
  }
  return pullRequest.mergeState === "ready" ? "ready" : "muted"
}

/** The sidebar deliberately compresses detailed ready/warning states to gray. */
export function pullRequestSidebarTone(pullRequest: PullRequestInfo): string {
  const tone = pullRequestIconTone(pullRequest)
  if (tone === "merged") return PULL_REQUEST_ICON_TONE.merged
  if (tone === "blocked") return PULL_REQUEST_ICON_TONE.blocked
  return PULL_REQUEST_ICON_TONE.muted
}
