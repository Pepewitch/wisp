/**
 * A task's pull request as the daemon reports it: GET /api/tasks/:id/pull-request
 * and GET /api/pull-requests. Provider failures never masquerade as "none".
 */
export type PullRequestLifecycle = "draft" | "open" | "merged" | "closed";
export type PullRequestChecks = "none" | "pending" | "passed" | "failed" | "unknown";
export type PullRequestReview = "none" | "required" | "approved" | "changes-requested" | "unknown";
export type PullRequestMergeState =
  | "ready"
  | "unstable"
  | "blocked"
  | "behind"
  | "conflicting"
  | "unknown";

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  lifecycle: PullRequestLifecycle;
  queuedToMerge: boolean;
  checks: PullRequestChecks;
  review: PullRequestReview;
  mergeState: PullRequestMergeState;
  updatedAt: string;
}

export type PullRequestStatus =
  | {
      kind: "found";
      provider: "github";
      pullRequest: PullRequestInfo;
      /** How many MORE this task has. Absent when this is the only one. */
      others?: number;
    }
  | { kind: "none"; provider: "github" }
  | { kind: "unsupported"; provider: null }
  | { kind: "unavailable"; provider: "github" | null };

export interface PullRequestOverviewEntry {
  status: PullRequestStatus;
  /** Time of the provider answer being displayed, not the latest failed attempt. */
  checkedAt: string;
  /** The last provider refresh failed, so status is the last successful answer. */
  stale: boolean;
}

/** GET /api/pull-requests: live tasks only; archived rows are deliberately absent. */
export interface PullRequestOverview {
  tasks: Record<string, PullRequestOverviewEntry>;
}
