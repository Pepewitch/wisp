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

/** At most this many names a task's work was pushed under: normally one, its own push. */
export const PUSHED_NAME_LIMIT = 2;

/**
 * How the task branch reached a tip, from its reflog subject: a commit made
 * on it (`commit:`, `commit (amend):`, `commit (merge):`), a cherry-pick, a
 * merge that made a commit, or a rebase. A fast-forward, a reset or the
 * branch's creation brought someone else's commit, never the task's own.
 */
function arrival(subject: string): "own" | "rebase" | null {
  if (/^(commit|cherry-pick)\b/.test(subject)) return "own";
  if (/^(merge|pull)\b[^:]*: Merge made by/.test(subject)) return "own";
  if (/^rebase( -i)? \(finish\): refs\/heads\//.test(subject)) return "rebase";
  return null;
}

/**
 * Branches on origin that hold this task's own work under another name: the
 * agent pushed with `git push origin HEAD:<name>` to follow a repository's
 * branch naming, so the pull request's head is `<name>` and no local branch
 * carries it. Read from the remote-tracking refs the push itself updated,
 * and claimed only on direct evidence the task made that tip: the task
 * branch's reflog shows the branch reaching it by a commit made on it (or a
 * cherry-pick, or a merge that made a commit), or by a rebase whose result no
 * other branch on origin also holds. A branch the task fast-forwarded or
 * reset onto (a sibling task's push, a colleague's branch) is never claimed,
 * whatever has happened to that branch since.
 *
 * Newest first, at most PUSHED_NAME_LIMIT. Empty for a task with no recorded
 * fork point (a local task), when the reflog is missing or has expired, and
 * whenever git cannot answer. A forge that deletes the head after a merge,
 * followed by a pruning fetch, removes the ref, and the merged PR is no
 * longer found this way.
 */
async function pushedUnderOtherNames(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<string[]> {
  const branch = task.branch, base = task.base_commit;
  if (!branch || !base) return [];
  const git = (args: string[]) =>
    Promise.resolve()
      .then(() => run(["git", ...args], { cwd: task.repo_path, signal }))
      .then((result) => (result.exitCode === 0 ? result.stdout : null))
      .catch(() => null);
  const listed = await git([
    "for-each-ref", "--sort=-committerdate", "--format=%(objectname) %(refname:lstrip=3)",
    `--merged=refs/heads/${branch}`, `--no-merged=${base}`, "refs/remotes/origin/",
  ]);
  const candidates = (listed ?? "").split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[1] !== "HEAD" && parts[1] !== "");
  if (candidates.length === 0) return [];
  const reflog = await git(["reflog", "show", "--format=%H %gs", `refs/heads/${branch}`]);
  if (reflog === null) return [];
  const made = new Map<string, "own" | "rebase">();
  for (const line of reflog.split("\n")) {
    const at = line.indexOf(" ");
    const how = at > 0 ? arrival(line.slice(at + 1)) : null;
    // an own commit wins over a rebase that later landed on the same tip
    if (how && made.get(line.slice(0, at)) !== "own") made.set(line.slice(0, at), how);
  }
  const names: string[] = [];
  for (const [tip, name] of candidates) {
    if (names.length >= PUSHED_NAME_LIMIT) break;
    const how = made.get(tip);
    if (!how) continue;
    if (how === "rebase") {
      // a rebase with nothing of the task's to replay lands on the other branch's own tip
      const holders = await git(["for-each-ref", "--format=%(refname:lstrip=3)", `--contains=${tip}`, "refs/remotes/origin/"]);
      const others = (holders ?? "").split("\n").map((line) => line.trim()).filter((holder) => holder !== "" && holder !== "HEAD" && holder !== name);
      if (holders === null || others.length > 0) continue;
    }
    names.push(name);
  }
  return names;
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
  return (await taskBranchDetail(task, run, signal)).branches;
}

/** taskBranches, with the names its work was pushed under apart: autopilot prefers a PR from those (bind.ts). */
export async function taskBranchDetail(
  task: Task,
  run: ProbeSpawnFn,
  signal: AbortSignal,
): Promise<{ branches: string[]; pushed: string[] }> {
  const stored = task.branch;
  if (!stored) return { branches: [], pushed: [] };
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
    return { branches: [...leading, ...others].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT), pushed: others };
  }
  // Only names git could have matched: the prefix is re-checked here so a
  // surprising stdout can never become a head in a provider query.
  const prefix = `wisp/${task.id}-`;
  const names = found.stdout
    .split("\n")
    .map((line) => line.trim())
    // git's order is kept, not re-sorted: it is the recency the cap spends
    .filter((line) => line.startsWith(prefix) && !leading.includes(line) && !others.includes(line));
  return { branches: [...leading, ...others, ...names].slice(0, PULL_REQUEST_TASK_BRANCH_LIMIT), pushed: others };
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
