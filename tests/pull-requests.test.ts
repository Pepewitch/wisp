import { describe, expect, test } from "bun:test";
import type { ProbeSpawnFn } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { route } from "../src/daemon";
import type { SpawnResult } from "../src/doctor";
import { PullRequestCache } from "../src/pull-requests";
import { createTask as createStoredTask, freeSlot, newTaskId, setTaskFields } from "../src/store";
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

function githubRun(
  rows: unknown[],
  origin = "git@github.com:acme/widgets.git",
): { run: ProbeSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd) => {
      calls.push(cmd);
      return Promise.resolve(
        cmd[0] === "git"
          ? ok(origin)
          : ok(JSON.stringify(rows)),
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

function graphQlResponse(rows: unknown[][]): SpawnResult {
  return ok(
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          rows.map((nodes, index) => [`b${index}`, { nodes }]),
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

    expect(calls[0]).toEqual(["git", "remote", "get-url", "origin"]);
    expect(calls[1]).toContain("acme/widgets");
    expect(calls[1]!.join(" ")).not.toContain("credential");
    expect(calls[1]!.join(" ")).toContain("mergeStateStatus");
    expect(calls[1]![calls[1]!.indexOf("--head") + 1]).toBe("wisp/tpr01-show-pr-status");
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

  test("prefers an active PR over a newer closed one, then reports legacy status contexts", async () => {
    const { run } = githubRun([
      row({
        number: 43,
        url: "https://github.com/acme/widgets/pull/43",
        state: "CLOSED",
        updatedAt: "2026-09-04T13:00:00Z",
      }),
      row({
        number: 42,
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
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets");
      ghCalls += 1;
      await Bun.sleep(20);
      return ok(
        JSON.stringify([row({ number: ghCalls, url: `https://github.com/acme/widgets/pull/${ghCalls}` })]),
      );
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
    // The evicted task repeats only the provider lookup: repository discovery
    // is cached once per repo path for both selected-task and overview reads.
    expect(calls.length - callsBeforeHits).toBe(1);
  });
});

describe("PullRequestCache overview", () => {
  test("batches live task branches by repository and omits archived tasks", async () => {
    const calls: string[][] = [];
    const run: ProbeSpawnFn = (cmd) => {
      calls.push(cmd);
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

    expect(calls.filter((cmd) => cmd[0] === "git")).toHaveLength(1);
    const providerCalls = calls.filter((cmd) => cmd[0] === "gh");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(providerCalls[0]!.join("\n")).toContain('headRefName: "wisp/first"');
    expect(providerCalls[0]!.join("\n")).toContain('headRefName: "wisp/second"');
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
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      return provider;
    };
    const cache = new PullRequestCache({ run });
    const target = task();

    const selected = cache.status(target);
    await Bun.sleep(0);
    const overview = cache.overview([target]);
    finish!(ok(JSON.stringify([row()])));

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

  test("keeps the last good overview stale, backs off failures, and stops refreshing merged PRs", async () => {
    let now = Date.parse("2026-09-05T08:00:00Z");
    let providerCalls = 0;
    let fail = false;
    let merged = false;
    const run: ProbeSpawnFn = (cmd) => {
      if (cmd[0] === "git") return ok("https://github.com/acme/widgets.git");
      providerCalls += 1;
      if (fail) return { exitCode: 1, stdout: "", stderr: "provider unavailable" };
      return graphQlResponse([
        [
          row(
            merged
              ? {
                  state: "MERGED",
                  mergedAt: "2026-09-05T08:01:00Z",
                  mergeStateStatus: "UNKNOWN",
                }
              : {},
          ),
        ],
      ]);
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
    merged = true;
    const recovered = await cache.overview([target]);
    expect(recovered.tasks[target.id]).toMatchObject({
      status: { kind: "found", pullRequest: { lifecycle: "merged" } },
      checkedAt: new Date(now).toISOString(),
      stale: false,
    });
    expect(providerCalls).toBe(3);

    now += 11;
    await cache.overview([target]);
    expect(providerCalls).toBe(3);

    expect(await cache.status(target)).toMatchObject({
      kind: "found",
      pullRequest: { lifecycle: "merged" },
    });
    expect(providerCalls).toBe(3);
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
