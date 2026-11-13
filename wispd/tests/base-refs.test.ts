import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterDef } from "../src/adapters";
import { createGhAutopilot } from "../src/autopilot/github";
import { BASE_REFS_FRESH_MS, BaseRefFetches, PREFETCH_COOLDOWN_MS } from "../src/base-refs";
import { cliClientHeaders } from "../src/cli-api";
import { CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { GitHubBudget } from "../src/github-budget";
import { route } from "../src/routes";
import { getTask } from "../src/store";
import type { Task } from "../src/types";
import { baseRefFetches, createWorktree, fetchBaseRefs } from "../src/worktree";
import { testRouteContext } from "./helpers/daemon-context";

/**
 * The composer's base-ref prefetch, and the create path that reuses it.
 *
 * What is pinned: one fetch per repo at a time, however many ask; a composer
 * create joins a running fetch rather than starting its own, and any other
 * create waits it out and fetches after it; only a fetch that
 * SUCCEEDED lets a create skip fetching; and the route runs git only in a
 * registered project, for an authenticated caller.
 *
 * The real-git tests count fetches where they land, on origin: the remote's
 * `uploadpack` is a script that records each fetch before handing over to
 * git-upload-pack, and can be told to be slow or to hang.
 */

const cfg = { envAllowlist: {}, setupTimeoutMinutes: 5 } as WispConfig;
/** what POST /api/tasks passes for a person's create from the web or Desktop composer */
const COMPOSER = { reuseRecent: true };
const FIXTURE_DIRS: string[] = [];

function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  FIXTURE_DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
  FIXTURE_DIRS.length = 0;
});

function sh(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function commitAll(repo: string, message: string): string {
  sh(["git", "add", "-A"], repo);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], repo);
  return sh(["git", "rev-parse", "HEAD"], repo);
}

interface Remote {
  repo: string;
  origin: string;
  /** how many fetches have reached origin */
  fetches: () => number;
  /** seconds origin waits before answering each fetch */
  delay: (seconds: number) => void;
  /** a commit landed on origin's main by someone else; returns it */
  push: (file: string) => string;
}

/** A clone whose origin counts the fetches it serves. Branch names forced, as in worktree.test.ts. */
function repoWithCountingRemote(): Remote {
  const root = fixtureDir("wisp-prefetch-");
  const origin = join(root, "origin.git");
  sh(["git", "init", "-q", "--bare", origin], root);
  sh(["git", "symbolic-ref", "HEAD", "refs/heads/main"], origin);
  const repo = join(root, "clone");
  sh(["git", "clone", "-q", origin, repo], root);
  writeFileSync(join(repo, "README.md"), "v1\n");
  commitAll(repo, "A");
  sh(["git", "branch", "-M", "main"], repo);
  sh(["git", "push", "-q", "-u", "origin", "main"], repo);

  const log = join(root, "fetches.log");
  const delayFile = join(root, "delay");
  writeFileSync(delayFile, "0");
  const script = join(root, "upload-pack.sh");
  writeFileSync(script, `#!/bin/sh\necho fetch >> '${log}'\nsleep "$(cat '${delayFile}')"\nexec git-upload-pack "$@"\n`);
  chmodSync(script, 0o755);
  // set after the initial push, so only fetches from here on are counted
  sh(["git", "config", "remote.origin.uploadpack", script], repo);

  let pushes = 0;
  return {
    repo,
    origin,
    fetches: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length : 0),
    delay: (seconds) => writeFileSync(delayFile, String(seconds)),
    push: (file) => {
      const work = join(root, `teammate-${pushes++}`);
      sh(["git", "clone", "-q", origin, work], root);
      writeFileSync(join(work, file), "from origin\n");
      const head = commitAll(work, `add ${file}`);
      sh(["git", "push", "-q", "origin", "main"], work);
      return head;
    },
  };
}

describe("BaseRefFetches (the rules, with a fake fetch and clock)", () => {
  function fake(): {
    fetches: BaseRefFetches;
    calls: () => number;
    /** settle fetch number `index` (the latest by default) */
    finish: (outcome: boolean | Error, index?: number) => void;
    advance: (ms: number) => void;
  } {
    let clock = 1_000;
    const pending: ((outcome: boolean | Error) => void)[] = [];
    const fetches = new BaseRefFetches(
      () =>
        new Promise<boolean>((resolve, reject) => {
          pending.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
        }),
      () => clock,
    );
    return {
      fetches,
      calls: () => pending.length,
      finish: (outcome, index = pending.length - 1) => pending[index]!(outcome),
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  test("prefetches for one repo coalesce, and a recent one is not repeated", async () => {
    const f = fake();
    const first = f.fetches.prefetch("/repo");
    expect(first.state).toBe("started");
    expect(f.fetches.prefetch("/repo").state).toBe("joined");
    // another repo is its own fetch
    expect(f.fetches.prefetch("/other").state).toBe("started");
    expect(f.calls()).toBe(2);
    f.finish(true, 0);
    await first.settled;
    f.advance(PREFETCH_COOLDOWN_MS - 1);
    expect(f.fetches.prefetch("/repo").state).toBe("recent");
    f.advance(1);
    expect(f.fetches.prefetch("/repo").state).toBe("started");
    expect(f.calls()).toBe(3);
  });

  test("a composer create joins the running fetch instead of starting a second", async () => {
    const f = fake();
    f.fetches.prefetch("/repo");
    let created = false;
    const create = f.fetches.beforeCreate("/repo", COMPOSER).then(() => {
      created = true;
    });
    await Bun.sleep(0);
    expect(created).toBe(false); // waiting on the prefetch, not past it
    expect(f.calls()).toBe(1);
    f.finish(true);
    await create;
    expect(f.calls()).toBe(1);
  });

  test("any other create waits out a running fetch, then starts its own", async () => {
    // an agent runs `gh pr merge`, then `wisp new`: a fetch already running may have begun before that merge
    const f = fake();
    f.fetches.prefetch("/repo");
    let created = false;
    const create = f.fetches.beforeCreate("/repo").then(() => {
      created = true;
    });
    await Bun.sleep(0);
    expect(f.calls()).toBe(1); // never two at once
    f.finish(true, 0);
    await Bun.sleep(0);
    expect(f.calls()).toBe(2); // its own fetch, begun after the create asked
    expect(created).toBe(false);
    f.finish(true, 1);
    await create;
    expect(f.calls()).toBe(2);
  });

  test("creates that are not the composer's each fetch after the one running, one fetch at a time", async () => {
    const f = fake();
    const first = f.fetches.beforeCreate("/repo");
    const second = f.fetches.beforeCreate("/repo");
    await Bun.sleep(0);
    expect(f.calls()).toBe(1);
    f.finish(true, 0);
    await first;
    await Bun.sleep(0);
    // the second asked while the first's fetch ran, so that fetch may predate what it must see
    expect(f.calls()).toBe(2);
    f.finish(true, 1);
    await second;
  });

  test("a fetch that began after a create asked is as good as its own, so that create joins it", async () => {
    const f = fake();
    f.fetches.prefetch("/repo");
    const first = f.fetches.beforeCreate("/repo");
    const second = f.fetches.beforeCreate("/repo");
    f.advance(10);
    f.finish(true, 0);
    await Bun.sleep(0);
    // the first waited out the prefetch and fetched again, after both asked
    expect(f.calls()).toBe(2);
    f.finish(true, 1);
    await Promise.all([first, second]);
    expect(f.calls()).toBe(2);
  });

  test("a composer create skips within the window of a success; an older one does not", async () => {
    const f = fake();
    const pre = f.fetches.prefetch("/repo");
    f.advance(5_000); // the fetch itself took a while: the window runs from its START
    f.finish(true);
    await pre.settled;
    f.advance(BASE_REFS_FRESH_MS - 5_001);
    await f.fetches.beforeCreate("/repo", COMPOSER);
    expect(f.calls()).toBe(1);

    f.advance(1);
    const create = f.fetches.beforeCreate("/repo", COMPOSER);
    expect(f.calls()).toBe(2);
    f.finish(true);
    await create;
  });

  test("any other create fetches however fresh the last success is", async () => {
    const f = fake();
    const pre = f.fetches.prefetch("/repo");
    f.finish(true);
    await pre.settled;
    // `wisp new`, an agent's subtask, autopilot: the default
    const create = f.fetches.beforeCreate("/repo");
    expect(f.calls()).toBe(2);
    f.finish(true);
    await create;
  });

  test("a failed or thrown (timed-out) fetch is never fresh", async () => {
    for (const outcome of [false, new Error("git fetch timed out after 20s and was stopped")]) {
      const f = fake();
      const pre = f.fetches.prefetch("/repo");
      f.finish(outcome);
      await pre.settled; // settles, never rejects: the route's caller is long gone
      const create = f.fetches.beforeCreate("/repo", COMPOSER);
      expect(f.calls()).toBe(2); // even a composer create fetched for itself
      f.finish(true);
      await create;
    }
  });

  test("a merge drops freshness and the cooldown", async () => {
    const f = fake();
    const pre = f.fetches.prefetch("/repo");
    f.finish(true);
    await pre.settled;
    f.fetches.invalidate("/repo");
    const again = f.fetches.prefetch("/repo");
    expect(again.state).toBe("started"); // not "recent"
    f.finish(true);
    await again.settled;
    f.fetches.invalidate("/repo");
    const create = f.fetches.beforeCreate("/repo", COMPOSER);
    expect(f.calls()).toBe(3);
    f.finish(true);
    await create;
  });

  test("a fetch that started before a merge is waited out, then fetched past", async () => {
    const f = fake();
    f.fetches.prefetch("/repo");
    f.fetches.invalidate("/repo"); // the merge lands while that fetch runs
    let created = false;
    const create = f.fetches.beforeCreate("/repo", COMPOSER).then(() => {
      created = true;
    });
    await Bun.sleep(0);
    expect(f.calls()).toBe(1); // never two at once
    f.finish(true, 0);
    await Bun.sleep(0);
    expect(f.calls()).toBe(2);
    expect(created).toBe(false);
    f.finish(true, 1);
    await create;
    // and that pre-merge success never became fresh
    await f.fetches.beforeCreate("/repo", COMPOSER);
    expect(f.calls()).toBe(2);
  });

  test("one repo however its path is spelled", async () => {
    const f = fake();
    const pre = f.fetches.prefetch("/work/repo/");
    expect(f.fetches.prefetch("/work/./repo").state).toBe("joined");
    f.finish(true);
    await pre.settled;
    await f.fetches.beforeCreate("/work/other/../repo", COMPOSER);
    expect(f.calls()).toBe(1);
  });
});

describe("prefetch against a real origin", () => {
  test("concurrent prefetches reach origin once", async () => {
    const remote = repoWithCountingRemote();
    remote.delay(1);
    const runs = [baseRefFetches.prefetch(remote.repo), baseRefFetches.prefetch(remote.repo), baseRefFetches.prefetch(remote.repo)];
    expect(runs.map((run) => run.state)).toEqual(["started", "joined", "joined"]);
    await Promise.all(runs.map((run) => run.settled));
    expect(remote.fetches()).toBe(1);
  });

  test("a composer create during a prefetch awaits it, fetches nothing itself, and forks from what it fetched", async () => {
    const remote = repoWithCountingRemote();
    const head = remote.push("teammate.txt");
    remote.delay(1); // long enough that the create reaches its fetch step first
    const pre = baseRefFetches.prefetch(remote.repo);
    const wt = await createWorktree(remote.repo, "tpre1", cfg, undefined, COMPOSER);
    await pre.settled;
    expect(remote.fetches()).toBe(1);
    expect(wt.base_ref).toBe("origin/main");
    expect(wt.base_commit).toBe(head);

    // right after, a composer create trusts that fetch; any other fetches again
    await createWorktree(remote.repo, "tpre2", cfg, undefined, COMPOSER);
    expect(remote.fetches()).toBe(1);
    await createWorktree(remote.repo, "tpre5", cfg);
    expect(remote.fetches()).toBe(2);
  });

  test("any other create during a prefetch waits it out, then fetches again", async () => {
    const remote = repoWithCountingRemote();
    const head = remote.push("teammate.txt");
    remote.delay(1);
    const pre = baseRefFetches.prefetch(remote.repo);
    const wt = await createWorktree(remote.repo, "tpre9", cfg);
    await pre.settled;
    expect(remote.fetches()).toBe(2);
    expect(wt.base_commit).toBe(head);
  });

  test("a failed prefetch is not fresh: the create fetches and sees the new commit", async () => {
    const remote = repoWithCountingRemote();
    sh(["git", "remote", "set-url", "origin", join(remote.origin, "..", "vanished.git")], remote.repo);
    await baseRefFetches.prefetch(remote.repo).settled;

    sh(["git", "remote", "set-url", "origin", remote.origin], remote.repo);
    const head = remote.push("later.txt");
    const before = remote.fetches();
    const wt = await createWorktree(remote.repo, "tpre3", cfg, undefined, COMPOSER);
    expect(remote.fetches()).toBe(before + 1); // even a composer create fetched for itself
    expect(wt.base_commit).toBe(head);
  });

  test("a prefetch that hits its deadline is not fresh either", async () => {
    const remote = repoWithCountingRemote();
    const head = remote.push("later.txt");
    // the real deadline is 20 s; the rule under test is the same at 1 s
    const impatient = new BaseRefFetches((repo) => fetchBaseRefs(repo, 1_000));
    remote.delay(30); // origin hangs past the deadline
    const started = Date.now();
    await impatient.prefetch(remote.repo).settled;
    expect(Date.now() - started).toBeLessThan(10_000); // stopped at its deadline, not origin's 30 s
    expect(sh(["git", "rev-parse", "origin/main"], remote.repo)).not.toBe(head);

    // whether the hung attempt got as far as origin is a race; the create's
    // own fetch arriving after it is not
    remote.delay(0);
    const before = remote.fetches();
    await impatient.beforeCreate(remote.repo, COMPOSER);
    expect(remote.fetches()).toBe(before + 1);
    expect(sh(["git", "rev-parse", "origin/main"], remote.repo)).toBe(head);
  });

  test("a repo with no origin: the prefetch is a quiet no-op and the create still starts", async () => {
    const repo = fixtureDir("wisp-prefetch-local-");
    sh(["git", "init", "-q"], repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    const head = commitAll(repo, "init");
    expect(await fetchBaseRefs(repo)).toBe(false);
    await baseRefFetches.prefetch(repo).settled;
    const wt = await createWorktree(repo, "tpre4", cfg);
    expect(wt.base_ref).toBeNull();
    expect(wt.base_commit).toBe(head);
  });
});

/**
 * The bug this rule exists for: an orchestrating task creates subtask A, its
 * agent merges a PR seconds later, and subtask B must fork from the merge.
 * Only a person's create from the composer may reuse a recent fetch.
 */
describe("who may reuse a recent fetch (POST /api/tasks)", () => {
  const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null };
  const adapters = { quick };
  const routeCfg = {
    ...cfg,
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 0,
    host: "127.0.0.1",
    token: "test",
    webhooks: [],
    repos: [],
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    harnessDefaults: {},
  } as WispConfig;

  async function create(repo: string, headers: Record<string, string>): Promise<Task> {
    const url = new URL("http://wisp.test/api/tasks");
    const res = await route(
      new Request(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ repoPath: repo, prompt: "go", harness: "quick", mode: "worktree" }),
      }),
      url,
      url.pathname,
      testRouteContext(routeCfg, adapters),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const deadline = Date.now() + 15_000;
    while (getTask(id)?.base_commit == null) {
      if (Date.now() > deadline || getTask(id)?.state === "failed") throw new Error(`task ${id} never got a worktree`);
      await Bun.sleep(25);
    }
    return getTask(id)!;
  }

  test("after a prefetch, the CLI, an agent and a bare API call still fetch; web and Desktop reuse it", async () => {
    const remote = repoWithCountingRemote();
    await baseRefFetches.prefetch(remote.repo).settled;
    expect(remote.fetches()).toBe(1);
    // the orchestrator's agent merges a PR seconds after the prefetch
    const merged = remote.push("merged.txt");
    const agent = cliClientHeaders({ WISP_AGENT_TURN: "1", WISP_TASK_ID: "orch1" });
    for (const headers of [agent, cliClientHeaders({}), {}]) {
      const before = remote.fetches();
      const task = await create(remote.repo, headers);
      expect(remote.fetches()).toBe(before + 1);
      expect(task.base_commit).toBe(merged);
    }
    // a person at the composer forks from that fetch without waiting, which
    // is the window's tradeoff: a commit landing inside it is not seen
    remote.push("later.txt");
    for (const client of ["web", "desktop"]) {
      const before = remote.fetches();
      const task = await create(remote.repo, { "x-wisp-client": client });
      expect(remote.fetches()).toBe(before);
      expect(task.base_commit).toBe(merged);
    }
  });

  test("a merge Wisp makes means even a composer create fetches again", async () => {
    const remote = repoWithCountingRemote();
    await baseRefFetches.prefetch(remote.repo).settled;
    const merged = remote.push("merged.txt");
    const github = createGhAutopilot({
      run: async () => ({ exitCode: 0, out: "", err: "", truncated: false, timedOut: false, cancelled: false }),
      budget: new GitHubBudget(),
    });
    const result = await github.merge({ repository: "owner/repo", number: 7, method: "SQUASH", head: "abc1234" }, remote.repo, new AbortController().signal);
    expect(result.ok).toBe(true);
    const wt = await createWorktree(remote.repo, "tpre6", cfg, undefined, COMPOSER);
    expect(remote.fetches()).toBe(2);
    expect(wt.base_commit).toBe(merged);
  });
});

describe("POST /api/projects/base-refs", () => {
  const token = "web-test-token";
  let server: Awaited<ReturnType<typeof serve>> | null = null;

  afterEach(async () => {
    if (server) await server.stop(true);
    server = null;
  });

  async function startServer(repos: string[]): Promise<string> {
    const config: WispConfig = {
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      port: 18710,
      host: "127.0.0.1",
      token,
      webhooks: [],
      repos,
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config));
    server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("no probes here"); }, modelProbeTimeoutMs: 100 });
    return `http://127.0.0.1:${server.port}`;
  }

  function post(base: string, body: unknown, auth = true): Promise<Response> {
    return fetch(`${base}/api/projects/base-refs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  test("a registered project answers 202 at once, and asking again joins the same fetch", async () => {
    const remote = repoWithCountingRemote();
    remote.delay(1);
    const base = await startServer([remote.repo]);
    const started = Date.now();
    const first = await post(base, { path: remote.repo });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ path: remote.repo, state: "started" });
    expect(Date.now() - started).toBeLessThan(1_000); // did not wait on the one-second origin
    expect(await (await post(base, { path: remote.repo })).json()).toEqual({ path: remote.repo, state: "joined" });
    await baseRefFetches.prefetch(remote.repo).settled;
    expect(remote.fetches()).toBe(1);
  });

  test("needs the daemon token", async () => {
    const remote = repoWithCountingRemote();
    const base = await startServer([remote.repo]);
    expect((await post(base, { path: remote.repo }, false)).status).toBe(401);
    await Bun.sleep(100);
    expect(remote.fetches()).toBe(0);
  });

  test("refuses any path that is not a registered project, before git runs there", async () => {
    const registered = repoWithCountingRemote();
    const stranger = repoWithCountingRemote();
    const base = await startServer([registered.repo]);

    const outside = await post(base, { path: stranger.repo });
    expect(outside.status).toBe(404);
    expect((await outside.json()).error).toContain("not a Wisp project");
    // a path that merely starts inside a project is not that project
    expect((await post(base, { path: join(registered.repo, "sub") })).status).toBe(404);
    expect((await post(base, { path: "relative/path" })).status).toBe(400);
    expect((await post(base, {})).status).toBe(400);
    await Bun.sleep(100);
    expect(stranger.fetches()).toBe(0);
    expect(registered.fetches()).toBe(0);
  });
});
