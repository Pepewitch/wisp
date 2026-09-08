/**
 * Which branches a task made, and which of their answers is the one to show.
 *
 * Split out of `pull-requests.ts` because it is the part with no cache, no
 * backoff and no provider in it: two pure-ish functions the daemon and its
 * tests can reason about on their own.
 */
import type { ProbeSpawnFn } from "./adapters";
import type { PullRequestStatus } from "./pull-requests";
import type { Task } from "./types";

/**
 * A cap on how many of one task's branches are queried. A task with more than
 * this many is not a task any more, and every extra head is a selection in a
 * GraphQL document shared with every other task in the repository.
 */
export const PULL_REQUEST_TASK_BRANCH_LIMIT = 8;

/**
 * Every branch this task made, newest name last, its branch of record first.
 *
 * `wisp/<id>-…` is the convention every worktree branch is created under, so
 * the id in the name is the whole index — nothing to record at push time,
 * nothing to keep in sync, and it survives the forge deleting a merged head
 * ref. Local refs are read, not remote ones, for exactly that reason: a
 * squash-merged branch is gone from origin within seconds and its pull request
 * is the one you most want to see.
 *
 * The stored branch always leads. It is the task's branch of record — the one
 * archive tears down and `/push` pushes — and it is included even when git
 * cannot be read at all, so this can only ever widen the old answer.
 */
export async function taskBranches(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<string[]> {
  const stored = task.branch;
  if (!stored) return [];
  const found = await Promise.resolve()
    .then(() =>
      run(
        [
          "git",
          "for-each-ref",
          // recency, not name: the cap truncates, and a name sort could drop
          // the branch holding the newest pull request
          "--sort=-committerdate",
          "--format=%(refname:short)",
          `refs/heads/wisp/${task.id}-*`,
        ],
        { cwd: task.repo_path, signal },
      ),
    )
    .catch(() => null);
  if (!found || found.exitCode !== 0) return [stored];
  // Only names git could have matched: the prefix is re-checked here so a
  // surprising stdout can never become a head in a provider query.
  const prefix = `wisp/${task.id}-`;
  const names = found.stdout
    .split("\n")
    .map((line) => line.trim())
    // git's order is kept: it is the recency the cap is about to spend
    .filter((line) => line.startsWith(prefix) && line !== stored);
  return [stored, ...names].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT);
}

/**
 * One answer out of a task's several branches: the NEWEST pull request, which
 * is the highest number the provider ever issued.
 *
 * A provider failure on any branch wins over a success on another, because the
 * newest could be the one that failed and reporting the older as current would
 * be a confident lie. `none` beats `unsupported` for the same reason: some
 * branch was genuinely asked about.
 */
export function pickPullRequest(statuses: PullRequestStatus[]): PullRequestStatus {
  if (statuses.length === 0) return { kind: "unsupported", provider: null };
  const unavailable = statuses.find((status) => status.kind === "unavailable");
  if (unavailable) return unavailable;
  const found = statuses.filter((status) => status.kind === "found");
  if (found.length > 0) {
    const newest = found.reduce((best, status) =>
      status.pullRequest.number > best.pullRequest.number ? status : best,
    );
    return found.length > 1
      ? { ...newest, others: found.length - 1 }
      : { kind: newest.kind, provider: newest.provider, pullRequest: newest.pullRequest };
  }
  return statuses.find((status) => status.kind === "none") ?? statuses[0]!;
}
