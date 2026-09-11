/**
 * Which branches are associated with a task, and which answer to show.
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
 * The named branch checked out in the task's worktree, or null for detached
 * HEAD and unreadable worktrees. This is deliberately read from worktree_path,
 * not repo_path: the repository's main checkout belongs to the user and can be
 * on an entirely different branch.
 */
async function currentTaskBranch(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<string | null> {
  const cwd = task.worktree_path;
  if (!cwd) return null;
  const result = await Promise.resolve()
    .then(() =>
      run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd, signal },
      ),
    )
    .catch(() => null);
  const branch = result?.exitCode === 0 ? result.stdout.trim() : "";
  return branch !== "" && !branch.includes("\n") ? branch : null;
}

/**
 * Every branch this task made, its branch of record first and current checkout
 * second, followed by its other task-named branches in recency order.
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
 *
 * The current checkout is next even when it has an arbitrary name. Commands
 * such as `gh pr checkout` move the worktree onto a provider-owned branch name
 * that cannot carry Wisp's task prefix; omitting HEAD there makes a real pull
 * request look absent while the Changes pane is already showing that branch.
 */
export async function taskBranches(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<string[]> {
  const stored = task.branch;
  if (!stored) return [];
  const [found, checkedOut] = await Promise.all([
    Promise.resolve()
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
      .catch(() => null),
    currentTaskBranch(task, run, signal),
  ]);
  if (!found || found.exitCode !== 0) {
    return checkedOut && checkedOut !== stored ? [stored, checkedOut] : [stored];
  }
  // Only names git could have matched: the prefix is re-checked here so a
  // surprising stdout can never become a head in a provider query.
  const prefix = `wisp/${task.id}-`;
  const names = found.stdout
    .split("\n")
    .map((line) => line.trim())
    // git's order is kept, not re-sorted: it is the recency the cap spends
    .filter((line) => line.startsWith(prefix) && line !== stored && line !== checkedOut);
  return [
    stored,
    ...(checkedOut && checkedOut !== stored ? [checkedOut] : []),
    ...names,
  ].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT);
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
