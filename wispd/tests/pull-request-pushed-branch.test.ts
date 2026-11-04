/**
 * A task whose agent pushed its branch under another name (`git push origin
 * HEAD:<name>`, to follow a repository's branch naming): the pull request's
 * head is that name, so it must be one of the task's branches. Real git, a
 * bare origin and a clone, as the agent's push leaves them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeSpawnFn } from "../src/adapters";
import { choosePull } from "../src/autopilot/bind";
import type { OpenPullRequest } from "../src/autopilot/github";
import { taskBranches } from "../src/pull-request-branches";
import type { Task } from "../src/types";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Wisp Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, "commit", "--allow-empty", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** origin with main and a colleague's branch; a clone with the task's branch forked from main. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "wisp-pushed-branch-"));
  const origin = join(root, "origin.git"), repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "checkout", "-q", "-b", "main");
  commit(repo, "initial");
  git(repo, "push", "-q", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "wisp/tpb01-keen-stork");
  return { repo, base };
}

function task(repo: string, base: string, extra: Partial<Task> = {}): Task {
  return { id: "tpb01", repo_path: repo, worktree_path: repo, branch: "wisp/tpb01-keen-stork", base_commit: base, base_ref: "origin/main", ...extra } as Task;
}

/** The test daemon's launch policy refuses git, so git runs here directly. */
const run: ProbeSpawnFn = async (cmd, opts) => {
  const result = Bun.spawnSync(cmd, { cwd: opts.cwd });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

const branches = (t: Task) => taskBranches(t, run, new AbortController().signal);

describe("a task's branch pushed under another name", () => {
  test("is one of the task's branches, so its pull request is found", async () => {
    const { repo, base } = world();
    commit(repo, "SUPER-1: the fix");
    git(repo, "push", "-q", "origin", "HEAD:fix/super-1-the-fix");
    expect(await branches(task(repo, base))).toEqual(["wisp/tpb01-keen-stork", "fix/super-1-the-fix"]);
    // a commit made after the push still finds it: its tip is in the task's history
    commit(repo, "SUPER-1: follow-up, not pushed yet");
    expect(await branches(task(repo, base))).toEqual(["wisp/tpb01-keen-stork", "fix/super-1-the-fix"]);
  });

  test("leaves out the base branch, branches that only came in by merging the base, and a task with no fork point", async () => {
    const { repo, base } = world();
    commit(repo, "SUPER-2: the fix");
    git(repo, "push", "-q", "origin", "HEAD:fix/super-2");
    // meanwhile a colleague's branch lands on main, and the task merges main in
    git(repo, "checkout", "-q", "-b", "colleague", base);
    commit(repo, "a colleague's change");
    git(repo, "push", "-q", "origin", "colleague");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "colleague");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "wisp/tpb01-keen-stork");
    git(repo, "merge", "-q", "--no-edit", "origin/main");
    expect(await branches(task(repo, base))).toEqual(["wisp/tpb01-keen-stork", "fix/super-2"]);
    // the base ref is not consulted: one that no longer resolves changes nothing
    expect(await branches(task(repo, base, { base_ref: "origin/gone" }))).toEqual(["wisp/tpb01-keen-stork", "fix/super-2"]);
    // a local task records no fork point: nothing on origin is claimed
    expect(await branches(task(repo, base, { base_commit: null }))).toEqual(["wisp/tpb01-keen-stork"]);
  });

  test("never claims a sibling task's or a colleague's branch the task merged in", async () => {
    const { repo, base } = world();
    // sibling task A, on its own local branch, pushed under another name
    git(repo, "checkout", "-q", "-b", "wisp/taaaa-a", base);
    commit(repo, "A's change");
    git(repo, "push", "-q", "origin", "HEAD:fix/a");
    // a colleague's branch, on origin only
    git(repo, "checkout", "-q", "-b", "colleague", base);
    commit(repo, "a colleague's change");
    git(repo, "push", "-q", "origin", "HEAD:feat/colleague");
    git(repo, "checkout", "-q", "wisp/tpb01-keen-stork");
    git(repo, "branch", "-q", "-D", "colleague");
    // B fast-forwards onto A's work, merges the colleague's, then makes and pushes its own change
    git(repo, "merge", "-q", "--ff-only", "origin/fix/a");
    git(repo, "merge", "-q", "--no-edit", "origin/feat/colleague");
    commit(repo, "B's change");
    git(repo, "push", "-q", "origin", "HEAD:fix/b");
    expect(await branches(task(repo, base))).toEqual(["wisp/tpb01-keen-stork", "fix/b"]);
  });

  test("names at most two pushes, newest first", async () => {
    const { repo, base } = world();
    for (const [at, name] of [[1, "fix/one"], [2, "fix/two"], [3, "fix/three"]] as const) {
      // committer dates order them, a minute apart
      const result = Bun.spawnSync(["git", "-c", "user.name=Wisp Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-q", "-m", name], {
        cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: `2026-11-04T00:0${at}:00Z` },
      });
      expect(result.exitCode).toBe(0);
      git(repo, "push", "-q", "origin", `HEAD:${name}`);
    }
    expect(await branches(task(repo, base))).toEqual(["wisp/tpb01-keen-stork", "fix/three", "fix/two"]);
  });
});

describe("autopilot's choice among the task's PRs", () => {
  test("prefers the task's own pushed name over an older PR of the same author", () => {
    const created = "2026-11-04T00:00:00Z";
    const pull = (number: number, head: string, at: string) =>
      ({ number, headRefName: head, baseRefName: "main", author: "owner", createdAt: at, isCrossRepository: false }) as OpenPullRequest;
    const sibling = pull(10, "fix/a", "2026-11-04T01:00:00Z"), own = pull(11, "fix/b", "2026-11-04T02:00:00Z");
    const t = { id: "tpb01", branch: "wisp/tpb01-keen-stork", created_at: created } as Task;
    expect(choosePull([sibling, own], t, "owner", new Set(["main"]), 0, ["fix/b"])?.number).toBe(11);
    // without the pushed name, the oldest onto the base, as before
    expect(choosePull([sibling, own], t, "owner", new Set(["main"]))?.number).toBe(10);
  });
});
