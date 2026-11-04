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
 * Branches on origin that hold this task's own work under another name: the
 * agent pushed with `git push origin HEAD:<name>` to follow a repository's
 * branch naming, so the pull request's head is `<name>` and no local branch
 * carries it. Read from the remote-tracking refs the push itself updated:
 * those whose tip is in the task branch's history but not in the commit it
 * forked from, nor in its base ref as it stands now (so the base branch, and
 * every branch that reached the task only by merging the base in, stay out).
 * Empty for a task with no recorded fork point (a local task), and whenever
 * git cannot answer.
 */
async function pushedUnderOtherNames(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<string[]> {
  if (!task.branch || !task.base_commit) return [];
  const query = (bases: string[]) =>
    Promise.resolve()
      .then(() =>
        run(
          [
            "git",
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            `--merged=refs/heads/${task.branch}`,
            ...bases.map((base) => `--no-merged=${base}`),
            "refs/remotes/origin/",
          ],
          { cwd: task.repo_path, signal },
        ),
      )
      .catch(() => null);
  // a base ref that no longer resolves fails the whole query: ask again without it
  let result = task.base_ref ? await query([task.base_commit, task.base_ref]) : null;
  if (!result || result.exitCode !== 0) result = await query([task.base_commit]);
  if (!result || result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("origin/") && line !== "origin/HEAD")
    .map((line) => line.slice("origin/".length))
    .filter((name) => name !== "" && !name.includes(" "));
}

/**
 * Every branch this task made, its branch of record first and current checkout
 * second, then the names its work was pushed under on origin, followed by its
 * other task-named branches in recency order.
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
  const [found, checkedOut, pushed] = await Promise.all([
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
    pushedUnderOtherNames(task, run, signal),
  ]);
  const leading = [stored, ...(checkedOut && checkedOut !== stored ? [checkedOut] : [])];
  const others = pushed.filter((name) => !leading.includes(name));
  if (!found || found.exitCode !== 0) {
    return [...leading, ...others].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT);
  }
  // Only names git could have matched: the prefix is re-checked here so a
  // surprising stdout can never become a head in a provider query.
  const prefix = `wisp/${task.id}-`;
  const names = found.stdout
    .split("\n")
    .map((line) => line.trim())
    // git's order is kept, not re-sorted: it is the recency the cap spends
    .filter((line) => line.startsWith(prefix) && !leading.includes(line) && !others.includes(line));
  return [...leading, ...others, ...names].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT);
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
