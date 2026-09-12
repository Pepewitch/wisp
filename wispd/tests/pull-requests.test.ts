import { describe, expect, test } from "bun:test";
import type { ProbeSpawnFn } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { route } from "../src/daemon";
import type { SpawnResult } from "../src/doctor";
import {
  pickPullRequest,
  PULL_REQUEST_TASK_BRANCH_LIMIT,
  taskBranches,
} from "../src/pull-request-branches";
import { PullRequestCache } from "../src/pull-requests";
import { createTask as createStoredTask, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";
import { syncTaskTitleWithPullRequest } from "../src/task-update";
import type { Task } from "../src/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tpr01",
    title: "Show pull request status",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/worktree",
    branch: "wisp/tpr01-show-pr-status",
    base_commit: "abc123",
    harness: "droid",
    model: null,
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: null,
    skills_json: null,
    seq: 1,
    turn_count: 1,
    archived: 0,
    mode: "worktree",
    created_at: "2026-09-04T00:00:00Z",
    updated_at: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

const ok = (stdout: string): SpawnResult => ({ exitCode: 0, stdout, stderr: "" });
const noCurrentBranch: SpawnResult = { exitCode: 1, stdout: "", stderr: "" };

/**
 * The daemon asks git two things before it asks the provider anything: which
 * repository this is, and which branches this task made (`wisp/<id>-…`). A
 * stub that answers every `git` the same way hands a remote URL back as a
 * branch name, so the two are answered separately.
 */
function githubRun(
  rows: unknown[],
  origin = "git@github.com:acme/widgets.git",
  branches: string[] = [],
  currentBranch: string | null = null,
): { run: ProbeSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "for-each-ref") return Promise.resolve(ok(branches.join("\n")));
      if (cmd[1] === "symbolic-ref") {
        return Promise.resolve(currentBranch === null ? noCurrentBranch : ok(currentBranch));
      }
      return Promise.resolve(
        cmd[0] === "git"
          ? ok(origin)
          : graphQlResponse(
              [rows.filter((candidate) =>
                typeof candidate === "object" &&
                candidate !== null &&
                "state" in candidate &&
                String(candidate.state).toUpperCase() === "OPEN"
              )],
              [rows.filter((candidate) =>
                !(
                  typeof candidate === "object" &&
                  candidate !== null &&
                  "state" in candidate &&
                  String(candidate.state).toUpperCase() === "OPEN"
                )
              )],
            ),
      );
    },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    title: "Show pull request status",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    mergedAt: null,
    updatedAt: "2026-09-04T12:00:00Z",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [],
    mergeStateStatus: "BLOCKED",
    ...overrides,
  };
}

function graphQlResponse(
  openRows: unknown[][],
  terminalRows: unknown[][] = openRows.map(() => []),
): SpawnResult {
  return ok(
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          openRows.flatMap((nodes, index) => [
            [`b${index}`, { nodes }],
            [`t${index}`, { nodes: terminalRows[index] ?? [] }],
          ]),
        ),
      },
    }),
  );
}

describe("PullRequestCache", () => {
  test("queries the origin for the task's original branch and normalizes lifecycle, CI, and review", async () => {
    const { run, calls } = githubRun(
      [
        row({
          isDraft: true,
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollup: [
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
            { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
          ],
        }),
      ],
      "https://credential@github.com/acme/widgets.git",
    );
    const result = await new PullRequestCache({ run }).status(task());

    // which repository, then task-named branches and current HEAD, then the provider
    expect(calls[0]).toEqual(["git", "remote", "get-url", "origin"]);
    expect(calls[1]).toEqual([
      "git",
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads/wisp/tpr01-*",
    ]);
    expect(calls[2]).toEqual(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
    expect(calls[3]).toContain("name=widgets");
    expect(calls[3]!.join(" ")).not.toContain("credential");
    expect(calls[3]!.join(" ")).toContain("mergeStateStatus");
    expect(calls[3]!.join(" ")).toContain('headRefName: "wisp/tpr01-show-pr-status"');
    expect(result).toEqual({
      kind: "found",
      provider: "github",
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/widgets/pull/42",
        title: "Show pull request status",
        lifecycle: "draft",
        checks: "pending",
        review: "changes-requested",
        mergeState: "blocked",
        updatedAt: "2026-09-04T12:00:00Z",
      },
    });
  });

  test("prefers the latest active PR over an older active PR and a newer closed one", async () => {
    const { run } = githubRun([
      row({
        number: 43,
        url: "https://github.com/acme/widgets/pull/43",
        state: "CLOSED",
        updatedAt: "2026-09-04T13:00:00Z",
      }),
      row({
        number: 5,
        url: "https://github.com/acme/widgets/pull/5",
        updatedAt: "2026-09-04T14:00:00Z",
      }),
      row({
        number: 42,
        updatedAt: "2026-09-04T12:00:00Z",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }],
        mergeStateStatus: "UNSTABLE",
      }),
    ]);

    const result = await new PullRequestCache({ run }).status(task());
    expect(result).toMatchObject({
      kind: "found",
      pullRequest: {
        number: 42,
        lifecycle: "open",
        checks: "failed",
        review: "approved",
        mergeState: "unstable",
      },
    });
  });

  test("normalizes a merged PR with successful checks and no review decision", async () => {
    const { run } = githubRun([
      row({
        state: "MERGED",
        mergedAt: "2026-09-04T12:30:00Z",
        reviewDecision: "",
        mergeStateStatus: "UNKNOWN",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }),
    ]);
    const result = await new PullRequestCache({ run }).status(task());
    expect(result).toMatchObject({
      kind: "found",
      pullRequest: {
        lifecycle: "merged",
        checks: "passed",
        review: "none",
        mergeState: "unknown",
      },
    });
  });

  test("normalizes GitHub's policy-aware merge states without recreating repository rules", async () => {
    const cases = [
      ["CLEAN", "ready"],
      ["HAS_HOOKS", "ready"],
      ["UNSTABLE", "unstable"],
      ["BLOCKED", "blocked"],
      ["BEHIND", "behind"],
      ["DIRTY", "conflicting"],
      ["UNKNOWN", "unknown"],
      ["FUTURE_VALUE", "unknown"],
    ] as const;

    for (const [providerState, expected] of cases) {
      const { run } = githubRun([row({ mergeStateStatus: providerState })]);
      expect(await new PullRequestCache({ run }).status(task())).toMatchObject({
        kind: "found",
        pullRequest: { mergeState: expected },
      });
    }
  });

  test("classifies stale checks as failed and future run statuses as unknown", async () => {
    const stale = githubRun([
      row({
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "STALE" },
        ],
      }),
    ]);
    expect(await new PullRequestCache({ run: stale.run }).status(task())).toMatchObject({
      kind: "found",
      pullRequest: { checks: "failed" },
    });

    const future = githubRun([
      row({
        statusCheckRollup: [
          { __typename: "CheckRun", status: "PAUSED", conclusion: null },
        ],
      }),
    ]);
    expect(await new PullRequestCache({ run: future.run }).status(task())).toMatchObject({
      kind: "found",
      pullRequest: { checks: "unknown" },
    });
  });

  test("keeps no associated PR distinct from unsupported and unavailable discovery", async () => {
    const empty = githubRun([row({ isCrossRepository: true })]);
    expect(await new PullRequestCache({ run: empty.run }).status(task())).toEqual({
      kind: "none",
      provider: "github",
    });

    let calls = 0;
    const unsupported: ProbeSpawnFn = () => {
      calls += 1;
      return Promise.resolve(ok("git@gitlab.com:acme/widgets.git"));
    };
    expect(await new PullRequestCache({ run: unsupported }).status(task())).toEqual({
      kind: "unsupported",
      provider: null,
    });
    expect(calls).toBe(1);

    const unavailable: ProbeSpawnFn = (cmd) =>
      Promise.resolve(cmd[0] === "git" ? ok("https://github.com/acme/widgets.git") : { exitCode: 1, stdout: "", stderr: "auth" });
    expect(await new PullRequestCache({ run: unavailable }).status(task())).toEqual({
      kind: "unavailable",
      provider: "github",
    });
  });

  test("does not attribute the current checkout of a local task to Wisp", async () => {
    let calls = 0;
    const run: ProbeSpawnFn = () => {
      calls += 1;
      return Promise.resolve(ok(""));
    };
    expect(await new PullRequestCache({ run }).status(task({ mode: "local" }))).toEqual({
      kind: "unsupported",
      provider: null,
    });
    expect(calls).toBe(0);
  });

  test("treats malformed provider output as unavailable rather than no PR", async () => {
    const run: ProbeSpawnFn = (cmd) =>
      Promise.resolve(cmd[0] === "git" ? ok("https://github.com/acme/widgets") : ok("{not json"));
    expect(await new PullRequestCache({ run }).status(task())).toEqual({
      kind: "unavailable",
      provider: "github",
    });

    const wrongRepository = githubRun([
      row({ url: "https://github.com/another/widgets/pull/42" }),
    ]);
    expect(await new PullRequestCache({ run: wrongRepository.run }).status(task())).toEqual({
      kind: "unavailable",
      provider: "github",
    });
  });

  test("caches briefly, refreshes after the TTL, and coalesces concurrent reads", async () => {
    let now = 1_000;
    let ghCalls = 0;
    const run: ProbeSpawnFn = async (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets");
      ghCalls += 1;
      await Bun.sleep(20);
      return graphQlResponse([[
        row({
          number: ghCalls,
          url: `https://github.com/acme/widgets/pull/${ghCalls}`,
        }),
      ]]);
    };
    const cache = new PullRequestCache({ run, ttlMs: 1_000, now: () => new Date(now) });

    const [first, same] = await Promise.all([cache.status(task()), cache.status(task())]);
    expect(ghCalls).toBe(1);
    expect(same).toEqual(first);
    expect(await cache.status(task())).toEqual(first);

    now += 1_001;
    expect(await cache.status(task())).toMatchObject({ pullRequest: { number: 2 } });
    expect(ghCalls).toBe(2);
  });

  test("refreshes a merged PR so a later open PR on the task branch can replace it", async () => {
    let now = 1_000;
    let ghCalls = 0;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets");
      ghCalls += 1;
      return ghCalls === 1
        ? graphQlResponse([[]], [[row({
            state: "MERGED",
            mergedAt: "2026-09-04T12:30:00Z",
          })]])
        : graphQlResponse([[row({
            number: 43,
            url: "https://github.com/acme/widgets/pull/43",
            updatedAt: "2026-09-04T13:00:00Z",
          })]]);
    };
    const cache = new PullRequestCache({ run, ttlMs: 1_000, now: () => new Date(now) });

    expect(await cache.status(task())).toMatchObject({
      pullRequest: { number: 42, lifecycle: "merged" },
    });
    now += 1_001;
    expect(await cache.status(task())).toMatchObject({
      pullRequest: { number: 43, lifecycle: "open" },
    });
    expect(ghCalls).toBe(2);
  });

  test("aborts a hung command at the timeout and caches the unavailable answer", async () => {
    let aborted = false;
    let calls = 0;
    const run: ProbeSpawnFn = (_cmd, opts) => {
      calls += 1;
      opts.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    };
    const cache = new PullRequestCache({ run, timeoutMs: 10, ttlMs: 1_000 });

    expect(await cache.status(task())).toEqual({ kind: "unavailable", provider: null });
    expect(aborted).toBe(true);
    expect(await cache.status(task())).toEqual({ kind: "unavailable", provider: null });
    expect(calls).toBe(1);
  });

  test("bounds cached task entries without evicting the most recently read one", async () => {
    const { run, calls } = githubRun([]);
    const cache = new PullRequestCache({ run });
    await cache.status(task({ id: "keep" }));
    await cache.status(task({ id: "touch" }));
    await cache.status(task({ id: "keep" }));
    for (let i = 0; i < 99; i += 1) {
      await cache.status(task({ id: `task-${i}` }));
    }

    const callsBeforeHits = calls.length;
    await cache.status(task({ id: "keep" }));
    await cache.status(task({ id: "touch" }));
    // The evicted task repeats its branch enumeration, current-branch read,
    // and provider lookup:
    // repository discovery is cached once per repo path for both selected-task
    // and overview reads, and both branch reads are local and cheap.
    expect(calls.length - callsBeforeHits).toBe(3);
  });
});

describe("every branch a task made", () => {
  /**
   * A task branches more than once: main moves under a long task, and the next
   * change wants its own review. The branch names carry the task id, so the
   * daemon can enumerate them out of local git without recording anything.
   */
  /** `row()` defaults to PR 42's url, and the parser checks the two agree. */
  const pr = (number: number, overrides: Record<string, unknown> = {}) =>
    row({ number, url: `https://github.com/acme/widgets/pull/${number}`, ...overrides });

  function multiBranchRun(
    perBranch: Record<string, unknown[]>,
    branches: string[],
    currentBranch: string | null = null,
  ): { run: ProbeSpawnFn; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: (cmd) => {
        calls.push(cmd);
        if (cmd[1] === "for-each-ref") return Promise.resolve(ok(branches.join("\n")));
        if (cmd[1] === "symbolic-ref") {
          return Promise.resolve(currentBranch === null ? noCurrentBranch : ok(currentBranch));
        }
        if (cmd[0] === "git") return Promise.resolve(ok("git@github.com:acme/widgets.git"));
        const query = cmd.join("\n");
        // answer each aliased selection with the rows for its head ref
        const heads = [...query.matchAll(/headRefName: "([^"]+)"/g)].map((m) => m[1]!);
        const unique = heads.filter((head, index) => heads.indexOf(head) === index);
        return Promise.resolve(
          graphQlResponse(
            unique.map((head) =>
              (perBranch[head] ?? []).filter(
                (candidate) => String((candidate as { state: string }).state) === "OPEN",
              ),
            ),
            unique.map((head) =>
              (perBranch[head] ?? []).filter(
                (candidate) => String((candidate as { state: string }).state) !== "OPEN",
              ),
            ),
          ),
        );
      },
    };
  }

  test("asks about every branch, not only the one the worktree was created on", async () => {
    const { run, calls } = multiBranchRun(
      {
        "wisp/tpr01-show-pr-status": [pr(48, { state: "MERGED", mergedAt: "2026-09-05T00:00:00Z" })],
        "wisp/tpr01-second-change": [pr(53, { state: "OPEN" })],
      },
      ["wisp/tpr01-second-change", "wisp/tpr01-show-pr-status"],
    );

    const result = await new PullRequestCache({ run }).status(task());

    const query = calls.find((cmd) => cmd[0] === "gh")!.join("\n");
    expect(query).toContain('headRefName: "wisp/tpr01-show-pr-status"');
    expect(query).toContain('headRefName: "wisp/tpr01-second-change"');
    // the NEWEST pull request, and an honest count of what it is newest of
    expect(result).toMatchObject({ kind: "found", others: 1 });
    expect((result as { pullRequest: { number: number } }).pullRequest.number).toBe(53);
  });

  test("asks about an arbitrary branch currently checked out in the task worktree", async () => {
    const { run, calls } = multiBranchRun(
      {
        "wisp/tpr01-show-pr-status": [],
        "fix/provider-owned-name": [pr(54, { state: "OPEN" })],
      },
      [],
      "fix/provider-owned-name",
    );

    const result = await new PullRequestCache({ run }).status(task());

    const current = calls.find((cmd) => cmd[1] === "symbolic-ref");
    expect(current).toEqual(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
    const query = calls.find((cmd) => cmd[0] === "gh")!.join("\n");
    expect(query).toContain('headRefName: "wisp/tpr01-show-pr-status"');
    expect(query).toContain('headRefName: "fix/provider-owned-name"');
    expect(result).toMatchObject({
      kind: "found",
      pullRequest: { number: 54 },
    });
  });

  test("counts nothing when the task made exactly one pull request", async () => {
    const { run } = multiBranchRun(
      {
        "wisp/tpr01-show-pr-status": [pr(48)],
        "wisp/tpr01-second-change": [],
      },
      ["wisp/tpr01-second-change"],
    );

    const result = await new PullRequestCache({ run }).status(task());

    expect(result).toMatchObject({ kind: "found" });
    expect(result).not.toHaveProperty("others");
  });

  test("renames from the selected PR repeatedly and honors the global opt-out", async () => {
    const stored = createStoredTask({
      id: newTaskId(),
      title: "Original task title",
      repo_path: "/tmp/repo",
      harness: "droid",
      model: null,
      slot: freeSlot(),
    });
    const firstBranch = `wisp/${stored.id}-first`;
    const secondBranch = `wisp/${stored.id}-second`;
    setTaskFields(stored.id, {
      branch: firstBranch,
      worktree_path: "/tmp/worktree",
    });
    const selectedTask = task({
      id: stored.id,
      title: stored.title,
      branch: firstBranch,
    });
    const cfg = { autoRenameTasksFromPullRequests: true };
    const sync = (taskWithPullRequest: Task, pullRequest: { title: string }) => {
      syncTaskTitleWithPullRequest(cfg, taskWithPullRequest.id, pullRequest.title);
    };

    const first = multiBranchRun(
      {
        [firstBranch]: [pr(48, { title: "First pull request" })],
      },
      [firstBranch],
    );
    await new PullRequestCache({
      run: first.run,
      onPullRequestFound: sync,
    }).status(selectedTask);
    expect(getTask(stored.id)?.title).toBe("First pull request");

    const next = multiBranchRun(
      {
        [firstBranch]: [pr(48, { title: "First pull request" })],
        [secondBranch]: [pr(53, { title: "Newest pull request" })],
      },
      [secondBranch, firstBranch],
    );
    await new PullRequestCache({
      run: next.run,
      onPullRequestFound: sync,
    }).overview([selectedTask]);
    expect(getTask(stored.id)?.title).toBe("Newest pull request");

    cfg.autoRenameTasksFromPullRequests = false;
    const optedOut = multiBranchRun(
      {
        [firstBranch]: [pr(48, { title: "First pull request" })],
        [secondBranch]: [pr(54, { title: "Ignored pull request" })],
      },
      [secondBranch, firstBranch],
    );
    await new PullRequestCache({
      run: optedOut.run,
      onPullRequestFound: sync,
    }).status(selectedTask);
    expect(getTask(stored.id)?.title).toBe("Newest pull request");
  });

  test("keeps answering after the forge deletes a merged head ref", async () => {
    // local refs are read, not remote ones: a squash-merged branch is gone from
    // origin within seconds, and its pull request is the one you want to see
    const { run, calls } = multiBranchRun(
      { "wisp/tpr01-deleted-remotely": [pr(60, { state: "MERGED", mergedAt: "2026-09-06T00:00:00Z" })] },
      ["wisp/tpr01-deleted-remotely"],
    );

    const result = await new PullRequestCache({ run }).status(task());

    expect(calls.find((cmd) => cmd[1] === "for-each-ref")).toEqual([
      "git",
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads/wisp/tpr01-*",
    ]);
    expect((result as { pullRequest: { number: number } }).pullRequest.number).toBe(60);
  });

  test("a provider failure on any branch is never dressed up as an older success", async () => {
    expect(
      pickPullRequest([
        { kind: "found", provider: "github", pullRequest: { number: 1 } as never },
        { kind: "unavailable", provider: "github" },
      ]),
    ).toEqual({ kind: "unavailable", provider: "github" });
  });

  test("some branch answered `none` beats a branch nobody could ask about", () => {
    expect(
      pickPullRequest([
        { kind: "unsupported", provider: null },
        { kind: "none", provider: "github" },
      ]),
    ).toEqual({ kind: "none", provider: "github" });
    expect(pickPullRequest([])).toEqual({ kind: "unsupported", provider: null });
  });

  test("the branch of record leads, and survives git being unreadable", async () => {
    const failing: ProbeSpawnFn = (cmd) =>
      cmd[1] === "for-each-ref" || cmd[1] === "symbolic-ref"
        ? Promise.reject(new Error("not a git repository"))
        : Promise.resolve(ok("git@github.com:acme/widgets.git"));

    await expect(
      taskBranches(task(), failing, new AbortController().signal),
    ).resolves.toEqual(["wisp/tpr01-show-pr-status"]);

    const listed: ProbeSpawnFn = (cmd) =>
      Promise.resolve(
        cmd[1] === "symbolic-ref"
          ? noCurrentBranch
          : ok(
              cmd[1] === "for-each-ref"
                ? ["wisp/tpr01-zzz", "wisp/tpr01-show-pr-status", "wisp/tpr01-aaa"].join("\n")
                : "git@github.com:acme/widgets.git",
            ),
      );
    // git's order is kept, not re-sorted by name: it is the recency the cap spends
    await expect(
      taskBranches(task(), listed, new AbortController().signal),
    ).resolves.toEqual(["wisp/tpr01-show-pr-status", "wisp/tpr01-zzz", "wisp/tpr01-aaa"]);
  });

  test("keeps the current checkout when task-named branch enumeration fails", async () => {
    let currentBranchCwd: string | undefined;
    const run: ProbeSpawnFn = (cmd, opts) => {
      if (cmd[1] === "for-each-ref") throw new Error("cannot enumerate refs");
      if (cmd[1] === "symbolic-ref") {
        currentBranchCwd = opts.cwd;
        return Promise.resolve(ok("fix/provider-owned-name"));
      }
      return Promise.resolve(ok(""));
    };

    await expect(
      taskBranches(task(), run, new AbortController().signal),
    ).resolves.toEqual([
      "wisp/tpr01-show-pr-status",
      "fix/provider-owned-name",
    ]);
    expect(currentBranchCwd).toBe("/tmp/worktree");
  });

  test("asks git for the freshest branches, and spends the cap on those", async () => {
    // 30 branches, listed the way `--sort=-committerdate` lists them: the cap
    // must keep the recent ones, because a name sort could drop the branch
    // holding the newest pull request — the one thing this is all for
    const many = Array.from({ length: 30 }, (_, i) => `wisp/tpr01-branch-${String(i).padStart(2, "0")}`);
    const calls: string[][] = [];
    const listed: ProbeSpawnFn = (cmd) => {
      calls.push(cmd);
      return Promise.resolve(
        cmd[1] === "symbolic-ref"
          ? noCurrentBranch
          : ok(cmd[1] === "for-each-ref" ? many.join("\n") : "git@github.com:acme/widgets.git"),
      );
    };

    const branches = await taskBranches(task(), listed, new AbortController().signal);

    expect(calls[0]).toContain("--sort=-committerdate");
    expect(branches).toHaveLength(PULL_REQUEST_TASK_BRANCH_LIMIT);
    expect(branches[0]).toBe("wisp/tpr01-show-pr-status");
    // the head of git's list survives; the stale tail is what falls off
    expect(branches[1]).toBe("wisp/tpr01-branch-00");
    expect(branches).not.toContain("wisp/tpr01-branch-29");
  });

  test("a stuck git in one worktree does not hold up the rest of the sidebar", async () => {
    // the overview enumerates inside an unbounded per-task Promise.all, so an
    // enumeration that never settles would hang the WHOLE refresh — every other
    // task's answer with it. Bounded, it falls back to the branch of record.
    const calls: string[][] = [];
    const stuck: ProbeSpawnFn = (cmd, opts) => {
      calls.push(cmd);
      if (cmd[1] === "for-each-ref") {
        return opts?.cwd === "/tmp/stuck"
          ? new Promise<SpawnResult>(() => {})
          : Promise.resolve(ok(""));
      }
      if (cmd[1] === "symbolic-ref") {
        return Promise.resolve(noCurrentBranch);
      }
      if (cmd[0] === "git") return Promise.resolve(ok("git@github.com:acme/widgets.git"));
      return Promise.resolve(graphQlResponse([[], []], [[], []]));
    };
    const cache = new PullRequestCache({ run: stuck, timeoutMs: 30 });
    const hangs = task({ id: "stuck", branch: "wisp/stuck-one", repo_path: "/tmp/stuck" });
    const fine = task({ id: "fine", branch: "wisp/fine-one" });

    const result = await cache.overview([hangs, fine]);

    // both answered, and the stuck task was still asked about by its branch
    expect(result.tasks.stuck!.status).toEqual({ kind: "none", provider: "github" });
    expect(result.tasks.fine!.status).toEqual({ kind: "none", provider: "github" });
    const query = calls.find((cmd) => cmd[0] === "gh")!.join("\n");
    expect(query).toContain('headRefName: "wisp/stuck-one"');
  });

  test("ignores anything git returned that is not one of this task's branches", async () => {
    // a stdout that is not a branch list must never become a head in a query
    const surprising: ProbeSpawnFn = (cmd) =>
      Promise.resolve(
        cmd[1] === "symbolic-ref"
          ? noCurrentBranch
          : ok(cmd[1] === "for-each-ref" ? "git@github.com:acme/widgets.git\nmain" : "git@github.com:acme/widgets.git"),
      );

    await expect(
      taskBranches(task(), surprising, new AbortController().signal),
    ).resolves.toEqual(["wisp/tpr01-show-pr-status"]);
  });
});

describe("PullRequestCache overview", () => {
  test("batches live task branches by repository and omits archived tasks", async () => {
    const calls: string[][] = [];
    const run: ProbeSpawnFn = (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("git@github.com:acme/widgets.git");
      return graphQlResponse([[row()], []]);
    };
    const now = new Date("2026-09-05T08:00:00Z");
    const cache = new PullRequestCache({ run, now: () => now });
    const first = task({ id: "first", branch: "wisp/first" });
    const second = task({ id: "second", branch: "wisp/second" });
    const local = task({ id: "local", branch: null, mode: "local" });
    const archived = task({ id: "archived", branch: "wisp/archived", archived: 1 });

    const result = await cache.overview([first, second, local, archived]);

    // one repository lookup, cached per repo path, plus one local branch read
    // for each of the two live worktree tasks
    expect(calls.filter((cmd) => cmd[1] === "remote")).toHaveLength(1);
    expect(calls.filter((cmd) => cmd[1] === "for-each-ref")).toHaveLength(2);
    const providerCalls = calls.filter((cmd) => cmd[0] === "gh");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(providerCalls[0]!.join("\n")).toContain('headRefName: "wisp/first"');
    expect(providerCalls[0]!.join("\n")).toContain('headRefName: "wisp/second"');
    expect(providerCalls[0]!.join("\n")).toContain("states: [OPEN]");
    expect(providerCalls[0]!.join("\n")).toContain("states: [CLOSED, MERGED]");
    expect(providerCalls[0]!.join("\n")).toContain(
      "orderBy: { field: CREATED_AT, direction: DESC }",
    );
    expect(result).toEqual({
      tasks: {
        first: {
          status: {
            kind: "found",
            provider: "github",
            pullRequest: expect.objectContaining({ number: 42 }),
          },
          checkedAt: now.toISOString(),
          stale: false,
        },
        second: {
          status: { kind: "none", provider: "github" },
          checkedAt: now.toISOString(),
          stale: false,
        },
        local: {
          status: { kind: "unsupported", provider: null },
          checkedAt: now.toISOString(),
          stale: false,
        },
      },
    });
    expect(result.tasks.archived).toBeUndefined();
  });

  test("chunks large repository overviews instead of spawning once per task", async () => {
    let providerCalls = 0;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      const query = cmd.find((part) => part.startsWith("query=")) ?? "";
      const aliases = [...query.matchAll(/\bb\d+: pullRequests/g)];
      return graphQlResponse(aliases.map(() => []));
    };
    const cache = new PullRequestCache({ run, overviewBatchSize: 2 });
    const tasks = ["one", "two", "three"].map((id) =>
      task({ id, branch: `wisp/${id}` }),
    );

    await cache.overview(tasks);

    expect(providerCalls).toBe(2);
  });

  test("shares an in-flight selected-task lookup with the sidebar overview", async () => {
    let providerCalls = 0;
    let finish: ((result: SpawnResult) => void) | undefined;
    const provider = new Promise<SpawnResult>((resolve) => {
      finish = resolve;
    });
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      return provider;
    };
    const cache = new PullRequestCache({ run });
    const target = task();

    const selected = cache.status(target);
    await Bun.sleep(0);
    const overview = cache.overview([target]);
    finish!(graphQlResponse([[row()]]));

    await expect(selected).resolves.toMatchObject({ kind: "found" });
    await expect(overview).resolves.toMatchObject({
      tasks: { [target.id]: { status: { kind: "found" } } },
    });
    expect(providerCalls).toBe(1);
  });

  test("keeps a shared selected lookup stale when its repository is backed off", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let providerCalls = 0;
    let finish: ((result: SpawnResult) => void) | undefined;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      if (providerCalls === 1) return graphQlResponse([[row()]]);
      return new Promise<SpawnResult>((resolve) => {
        finish = resolve;
      });
    };
    const cache = new PullRequestCache({
      run,
      ttlMs: 1,
      overviewTtlMs: 10,
      overviewBackoffBaseMs: 100,
      overviewBackoffMaxMs: 100,
      now: () => new Date(now),
    });
    const target = task();
    const fresh = await cache.overview([target]);

    now += 11;
    const selected = cache.status(target);
    await Bun.sleep(0);
    const overview = cache.overview([target]);
    finish!({ exitCode: 1, stdout: "", stderr: "provider unavailable" });

    await expect(selected).resolves.toMatchObject({ kind: "unavailable" });
    await expect(overview).resolves.toEqual({
      tasks: {
        [target.id]: {
          ...fresh.tasks[target.id]!,
          stale: true,
        },
      },
    });
  });

  test("marks the current overview stale as soon as a selected refresh fails", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let fail = false;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      if (fail) return { exitCode: 1, stdout: "", stderr: "provider unavailable" };
      return graphQlResponse([[row()]]);
    };
    const cache = new PullRequestCache({
      run,
      ttlMs: 1,
      now: () => new Date(now),
    });
    const target = task();
    const fresh = await cache.overview([target]);

    now += 2;
    fail = true;
    await expect(cache.status(target)).resolves.toMatchObject({
      kind: "unavailable",
    });
    expect(await cache.overview([target])).toEqual({
      tasks: {
        [target.id]: {
          ...fresh.tasks[target.id]!,
          stale: true,
        },
      },
    });
  });

  test("does not extend a selected cache hit when the overview reuses it", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    const { run, calls } = githubRun([row()]);
    const cache = new PullRequestCache({
      run,
      now: () => new Date(now),
    });
    const target = task();

    await cache.status(target);
    now += 20_000;
    await cache.overview([target]);
    now += 6_000;
    await cache.status(target);

    expect(calls.filter((cmd) => cmd[0] === "gh")).toHaveLength(2);
  });

  test("backs off one unavailable repository without throttling healthy repositories", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let failingCalls = 0;
    let healthyCalls = 0;
    const run: ProbeSpawnFn = (cmd, opts) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") {
        return ok(
          opts.cwd === "/tmp/failing"
            ? "https://github.com/acme/failing.git"
            : "https://github.com/acme/healthy.git",
        );
      }
      if (cmd.includes("name=failing")) {
        failingCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "unavailable" };
      }
      healthyCalls += 1;
      return graphQlResponse([[]]);
    };
    const cache = new PullRequestCache({
      run,
      ttlMs: 1,
      overviewTtlMs: 10,
      overviewBackoffBaseMs: 100,
      overviewBackoffMaxMs: 100,
      now: () => new Date(now),
    });
    const failing = task({
      id: "failing",
      repo_path: "/tmp/failing",
      branch: "wisp/failing",
    });
    const healthy = task({
      id: "healthy",
      repo_path: "/tmp/healthy",
      branch: "wisp/healthy",
    });

    const first = await cache.overview([failing, healthy]);
    expect(first.tasks.failing?.status.kind).toBe("unavailable");
    expect(first.tasks.healthy?.status.kind).toBe("none");
    expect(await cache.status(failing)).toMatchObject({ kind: "unavailable" });
    expect(failingCalls).toBe(1);

    now += 11;
    await cache.overview([failing, healthy]);
    expect(failingCalls).toBe(1);
    expect(healthyCalls).toBe(2);
  });

  test("times out one repository without discarding healthy repository answers", async () => {
    let slowAborted = false;
    const run: ProbeSpawnFn = (cmd, opts) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") {
        return ok(
          opts.cwd === "/tmp/slow"
            ? "https://github.com/acme/slow.git"
            : "https://github.com/acme/healthy.git",
        );
      }
      if (cmd.includes("name=slow")) {
        opts.signal?.addEventListener("abort", () => {
          slowAborted = true;
        });
        return new Promise(() => {});
      }
      return graphQlResponse([
        [row({ url: "https://github.com/acme/healthy/pull/42" })],
      ]);
    };
    const cache = new PullRequestCache({ run, timeoutMs: 10 });
    const slow = task({
      id: "slow",
      repo_path: "/tmp/slow",
      branch: "wisp/slow",
    });
    const healthy = task({
      id: "healthy",
      repo_path: "/tmp/healthy",
      branch: "wisp/healthy",
    });

    const result = await cache.overview([slow, healthy]);

    expect(slowAborted).toBe(true);
    expect(result.tasks.slow).toMatchObject({
      status: { kind: "unavailable", provider: "github" },
      stale: false,
    });
    expect(result.tasks.healthy).toMatchObject({
      status: { kind: "found", pullRequest: { number: 42 } },
      stale: false,
    });
  });

  test("does not turn a last-known answer fresh while its repository is backed off", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let fail = false;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      return fail
        ? { exitCode: 1, stdout: "", stderr: "provider unavailable" }
        : graphQlResponse([[row()]]);
    };
    const cache = new PullRequestCache({
      run,
      ttlMs: 1,
      overviewTtlMs: 10,
      overviewBackoffBaseMs: 100,
      overviewBackoffMaxMs: 100,
      now: () => new Date(now),
    });
    const target = task();
    const fresh = await cache.overview([target]);

    now += 11;
    fail = true;
    await cache.overview([target]);
    expect(await cache.status(target)).toMatchObject({ kind: "found" });

    now += 11;
    const backedOff = await cache.overview([target]);
    expect(backedOff.tasks[target.id]).toEqual({
      ...fresh.tasks[target.id]!,
      stale: true,
    });
  });

  test("keeps the last good overview stale, backs off failures, and finds a PR opened after a merge", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let providerCalls = 0;
    let fail = false;
    let providerState: "open" | "merged" | "new-open" = "open";
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[1] === "symbolic-ref") return noCurrentBranch;
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      if (fail) return { exitCode: 1, stdout: "", stderr: "provider unavailable" };
      const merged = row({
        state: "MERGED",
        mergedAt: "2026-09-05T08:01:00Z",
        mergeStateStatus: "UNKNOWN",
      });
      if (providerState === "merged") return graphQlResponse([[]], [[merged]]);
      if (providerState === "new-open") {
        return graphQlResponse(
          [[row({
            number: 43,
            url: "https://github.com/acme/widgets/pull/43",
            updatedAt: "2026-09-05T08:02:00Z",
          })]],
          [[merged]],
        );
      }
      return graphQlResponse([[row()]]);
    };
    const cache = new PullRequestCache({
      run,
      ttlMs: 1,
      overviewTtlMs: 10,
      overviewBackoffBaseMs: 100,
      overviewBackoffMaxMs: 100,
      now: () => new Date(now),
    });
    const target = task();

    const fresh = await cache.overview([target]);
    expect(fresh.tasks[target.id]).toMatchObject({
      status: { kind: "found", pullRequest: { lifecycle: "open" } },
      checkedAt: new Date(now).toISOString(),
      stale: false,
    });

    now += 11;
    fail = true;
    const stale = await cache.overview([target]);
    expect(stale.tasks[target.id]).toEqual({
      ...fresh.tasks[target.id]!,
      stale: true,
    });
    expect(providerCalls).toBe(2);
    expect(await cache.status(target)).toMatchObject({
      kind: "found",
      pullRequest: { lifecycle: "open" },
    });
    expect(providerCalls).toBe(2);

    now += 11;
    await cache.overview([target]);
    expect(providerCalls).toBe(2);

    now += 100;
    fail = false;
    providerState = "merged";
    const recovered = await cache.overview([target]);
    expect(recovered.tasks[target.id]).toMatchObject({
      status: { kind: "found", pullRequest: { lifecycle: "merged" } },
      checkedAt: new Date(now).toISOString(),
      stale: false,
    });
    expect(providerCalls).toBe(3);

    now += 11;
    providerState = "new-open";
    const latest = await cache.overview([target]);
    expect(latest.tasks[target.id]).toMatchObject({
      status: {
        kind: "found",
        pullRequest: { number: 43, lifecycle: "open" },
      },
      checkedAt: new Date(now).toISOString(),
      stale: false,
    });
    expect(providerCalls).toBe(4);

    expect(await cache.status(target)).toMatchObject({
      kind: "found",
      pullRequest: { number: 43, lifecycle: "open" },
    });
    expect(providerCalls).toBe(4);
  });
});

test("GET /api/tasks/:id/pull-request serves the normalized provider-neutral status", async () => {
  const stored = createStoredTask({
    id: newTaskId(),
    title: "route contract",
    repo_path: "/tmp/repo",
    harness: "droid",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(stored.id, { branch: "wisp/troute-pr-status" });
  const { run } = githubRun([row()]);
  const pullRequests = new PullRequestCache({ run });
  const url = new URL(`http://wisp.test/api/tasks/${stored.id}/pull-request`);
  const cfg = {
    repos: [],
    webhooks: [],
    envAllowlist: {},
    harnessDefaults: {},
  } as unknown as WispConfig;

  const response = await route(
    new Request(url),
    url,
    url.pathname,
    cfg,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    pullRequests,
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    kind: "found",
    provider: "github",
    pullRequest: {
      number: 42,
      lifecycle: "open",
      checks: "none",
      review: "required",
      mergeState: "blocked",
    },
  });
});

test("GET /api/pull-requests serves the batched live-task overview", async () => {
  const stored = createStoredTask({
    id: newTaskId(),
    title: "overview route contract",
    repo_path: "/tmp/repo",
    harness: "droid",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(stored.id, { branch: "wisp/toverview-pr-status" });
  const run: ProbeSpawnFn = (cmd) => {
    if (cmd[1] === "symbolic-ref") return noCurrentBranch;
    if (cmd[0] === "git") return ok("https://github.com/acme/widgets");
    const query = cmd.find((part) => part.startsWith("query=")) ?? "";
    const aliases = [...query.matchAll(/\bb\d+: pullRequests/g)];
    return graphQlResponse(aliases.map(() => [row()]));
  };
  const pullRequests = new PullRequestCache({ run });
  const url = new URL("http://wisp.test/api/pull-requests");
  const cfg = {
    repos: [],
    webhooks: [],
    envAllowlist: {},
    harnessDefaults: {},
  } as unknown as WispConfig;

  const response = await route(
    new Request(url),
    url,
    url.pathname,
    cfg,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    pullRequests,
  );

  expect(response.status).toBe(200);
  const body = await response.json() as {
    tasks: Record<string, unknown>;
  };
  expect(body.tasks[stored.id]).toMatchObject({
    status: {
      kind: "found",
      provider: "github",
      pullRequest: { number: 42 },
    },
    stale: false,
  });
});
