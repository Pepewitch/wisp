import type {
  PullRequestInfo,
  PullRequestOverview,
  PullRequestStatus,
} from "./pull-requests";
import type { Task } from "./types";

export type PullRequestFound = (
  task: Task,
  pullRequest: PullRequestInfo,
) => void;

/**
 * Provider metadata is useful even if a secondary side effect fails. Keep a
 * title-write failure from turning successful PR discovery into a 500.
 */
export function reportPullRequest(
  callback: PullRequestFound | undefined,
  task: Task,
  status: PullRequestStatus,
): void {
  if (status.kind !== "found" || !callback) return;
  try {
    callback(task, status.pullRequest);
  } catch (error) {
    console.warn(
      `[wisp] could not apply pull request #${status.pullRequest.number} title to task ${task.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function reportPullRequestOverview(
  callback: PullRequestFound | undefined,
  tasks: Task[],
  overview: PullRequestOverview,
): PullRequestOverview {
  for (const task of tasks) {
    const status = overview.tasks[task.id]?.status;
    if (status) reportPullRequest(callback, task, status);
  }
  return overview;
}
