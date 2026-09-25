import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  FACTORY_API,
  LimitsError,
  normalizeCodexLimits,
  normalizeFactoryLimits,
  parseClaudeReset,
  parseClaudeUsage,
  runLimits,
  validateAdapters,
  windowLabel,
  type LimitsIo,
  type RpcFactory,
  type RpcSession,
} from "../src/adapters";
import { HarnessLimitsCache, factoryKey } from "../src/harness-limits";
import { route } from "../src/routes";
import type { WispConfig } from "../src/config";
import { limitsLines, resetsIn } from "../src/cli-limits";

const claude = BUILTIN_ADAPTERS.claude!;
const codex = BUILTIN_ADAPTERS.codex!;
const droid = BUILTIN_ADAPTERS.droid!;
const NOW = new Date("2026-09-25T02:00:00.000Z");
const KEY = "factory-test-sample-value";

function scriptedRpc(table: Record<string, unknown>): { openRpc: RpcFactory; calls: string[]; state: { closed: boolean } } {
  const calls: string[] = [];
  const state = { closed: false };
  return {
    calls,
    state,
    openRpc: () => {
      const session: RpcSession = {
        call(method) {
          calls.push(method);
          if (!(method in table)) return Promise.reject(new Error(`unknown method ${method}`));
          return Promise.resolve(table[method]);
        },
        close() {
          state.closed = true;
        },
      };
      return session;
    },
  };
}

function ioOf(partial: Partial<LimitsIo> = {}): LimitsIo {
  return {
    spawnOnce: partial.spawnOnce ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
    openRpc: partial.openRpc ?? scriptedRpc({}).openRpc,
    fetch: partial.fetch ?? (() => Promise.reject(new Error("no network in tests"))),
    readFile: partial.readFile ?? (() => null),
    homeDir: partial.homeDir ?? "/home/test",
    scratchDir: partial.scratchDir ?? "/tmp/scratch",
  };
}

const CLAUDE_REPORT = [
  "Current session: 33% used · resets Sep 25 at 5:49am (UTC)",
  "Current week (all models): 51% used · resets Sep 30 at 3:59am (UTC)",
  "Current week (Opus): 0% used · resets Sep 30 at 4am (UTC)",
].join("\n");

const FACTORY_BILLING = {
  limits: {
    standard: {
      fiveHour: { usedPercent: 12.5, windowEnd: "2026-09-25T04:30:00.000Z" },
      weekly: { usedPercent: 40, windowEnd: "2026-09-29T00:00:00.000Z" },
      monthly: { usedPercent: 70, windowEnd: "2026-10-01T00:00:00.000Z" },
    },
    core: {
      // not opened yet, and one whose end already passed: both are a fresh window
      fiveHour: { usedPercent: 0, windowEnd: null },
      weekly: { usedPercent: 90, windowEnd: "2026-09-24T00:00:00.000Z" },
      monthly: { usedPercent: 5, windowEnd: "2026-10-01T00:00:00.000Z" },
    },
  },
};

const LOGIN = JSON.stringify({ userId: "user-a", orgId: "org-a" });

function factoryFetch(answers: { whoami?: unknown; billing?: unknown; status?: number }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: LimitsIo["fetch"] = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (answers.status) return new Response("{}", { status: answers.status });
    const body = url.endsWith("/api/cli/whoami") ? answers.whoami : answers.billing;
    return Response.json(body);
  };
  return { fetch, calls };
}

describe("limits strategy wiring", () => {
  test("the builtins declare a limits read for claude, codex and droid only", () => {
    const declared = Object.fromEntries(
      Object.entries(BUILTIN_ADAPTERS).map(([name, def]) => [name, def.limits ?? null]),
    );
    expect(declared).toEqual({
      claude: "claude-usage",
      droid: "factory-billing",
      codex: "codex-rate-limits",
      cursor: null,
      opencode: null,
    });
  });

  test("config validation names an unknown limits strategy", () => {
    expect(() => validateAdapters({ x: { ...claude, limits: "made-up" } })).toThrow(/limits/);
    expect(() => validateAdapters({ x: { ...claude, limits: null } })).not.toThrow();
  });
});

describe("window labels", () => {
  test("a stated length reads as hours or days", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10_080)).toBe("7d");
    expect(windowLabel(90)).toBe("90m");
    expect(windowLabel(null)).toBe("limit");
  });
});

describe("claude /usage", () => {
  test("parses the session, the week and each per-model week", () => {
    expect(parseClaudeUsage(CLAUDE_REPORT, NOW)).toEqual({
      plan: null,
      windows: [
        { id: "session", label: "5h", pool: null, usedPercent: 33, resetsAt: "2026-09-25T05:49:00.000Z", windowMins: 300 },
        { id: "week", label: "7d", pool: null, usedPercent: 51, resetsAt: "2026-09-30T03:59:00.000Z", windowMins: 10_080 },
        { id: "week:opus", label: "Opus", pool: null, usedPercent: 0, resetsAt: "2026-09-30T04:00:00.000Z", windowMins: 10_080 },
      ],
    });
  });

  test("a reset with no year is the next such instant", () => {
    expect(parseClaudeReset("Jan 2 at 1am (UTC)", new Date("2026-12-30T00:00:00Z"))).toBe("2027-01-02T01:00:00.000Z");
    expect(parseClaudeReset("Sep 30, 2027 at 4pm (UTC)", NOW)).toBe("2027-09-30T16:00:00.000Z");
    expect(parseClaudeReset("1:15am (UTC)", NOW)).toBe("2026-09-26T01:15:00.000Z");
    // any zone but UTC means claude's wording moved
    expect(parseClaudeReset("Sep 30 at 4am (PDT)", NOW)).toBeNull();
  });

  test("an account without plan limits is unavailable, in claude's words", () => {
    const error = (() => {
      try {
        parseClaudeUsage("You are using an API key.", NOW);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(LimitsError);
    expect(error).toMatchObject({ status: "unavailable", message: "claude reports no plan limits: You are using an API key." });
  });

  test("runs claude in print mode, in UTC, off the user's session history", async () => {
    const calls: { cmd: string[]; opts: unknown }[] = [];
    const io = ioOf({
      spawnOnce: (cmd, opts) => {
        calls.push({ cmd, opts });
        return { exitCode: 0, stdout: `${JSON.stringify({ type: "result", is_error: false, result: CLAUDE_REPORT })}\n`, stderr: "" };
      },
    });
    const limits = await runLimits(claude, { now: NOW, credential: null }, io);
    expect(limits.windows.map((w) => w.label)).toEqual(["5h", "7d", "Opus"]);
    expect(calls[0]!.cmd).toEqual([claude.bin, "-p", "/usage", "--output-format", "json", "--no-session-persistence"]);
    expect(calls[0]!.opts).toMatchObject({ cwd: "/tmp/scratch", env: { TZ: "UTC" } });
  });

  test("no JSON answer is a named error with claude's own stderr", async () => {
    const io = ioOf({ spawnOnce: () => ({ exitCode: 1, stdout: "", stderr: "not logged in\nmore" }) });
    await expect(runLimits(claude, { now: NOW, credential: null }, io)).rejects.toThrow(
      "claude answered /usage with no report (exit 1): not logged in",
    );
  });
});

describe("codex rate limits", () => {
  test("labels windows by their stated length, not by position", () => {
    const limits = normalizeCodexLimits({
      rateLimits: {
        limitId: "codex",
        planType: "team",
        primary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_790_000_000 },
        secondary: null,
      },
    });
    expect(limits).toEqual({
      plan: "team",
      windows: [
        {
          id: "codex:primary",
          label: "7d",
          pool: null,
          usedPercent: 20,
          windowMins: 10_080,
          resetsAt: new Date(1_790_000_000_000).toISOString(),
        },
      ],
    });
  });

  test("reads every limit by id, pools per-model ones and turns remaining credits into used", () => {
    const limits = normalizeCodexLimits({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "plus",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
          secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: null },
          individualLimit: { remainingPercent: 75, resetsAt: null },
        },
        other: { limitId: "other", limitName: "Other model", primary: { usedPercent: 50, windowDurationMins: 300 } },
      },
    });
    expect(limits.plan).toBe("plus");
    expect(limits.windows.map((w) => [w.id, w.label, w.pool, w.usedPercent])).toEqual([
      ["codex:primary", "5h", null, 10],
      ["codex:secondary", "7d", null, 30],
      ["codex:credits", "credits", null, 25],
      ["other:primary", "5h", "Other model", 50],
    ]);
  });

  test("no windows is unavailable, and a non-object is an error", () => {
    expect(() => normalizeCodexLimits({ rateLimits: { primary: null, secondary: null } })).toThrow(LimitsError);
    expect(() => normalizeCodexLimits("nope")).toThrow(/not a JSON object/);
  });

  test("initializes the app-server, reads, and always closes it", async () => {
    const rpc = scriptedRpc({
      initialize: {},
      "account/rateLimits/read": { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } },
    });
    const limits = await runLimits(codex, { now: NOW, credential: null }, ioOf({ openRpc: rpc.openRpc }));
    expect(limits.windows).toHaveLength(1);
    expect(rpc.calls).toEqual(["initialize", "account/rateLimits/read"]);
    expect(rpc.state.closed).toBe(true);

    const failing = scriptedRpc({ initialize: {} });
    await expect(runLimits(codex, { now: NOW, credential: null }, ioOf({ openRpc: failing.openRpc }))).rejects.toBeInstanceOf(LimitsError);
    expect(failing.state.closed).toBe(true);
  });
});

describe("droid via Factory billing", () => {
  test("both pools, each bucket; an idle or ended window reads as a fresh one", () => {
    const limits = normalizeFactoryLimits(FACTORY_BILLING, NOW);
    expect(limits.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt])).toEqual([
      ["standard:fiveHour", "5h", 12.5, "2026-09-25T04:30:00.000Z"],
      ["standard:weekly", "weekly", 40, "2026-09-29T00:00:00.000Z"],
      ["standard:monthly", "monthly", 70, "2026-10-01T00:00:00.000Z"],
      ["core:fiveHour", "5h", 0, null],
      ["core:weekly", "weekly", 0, null],
      ["core:monthly", "monthly", 5, "2026-10-01T00:00:00.000Z"],
    ]);
    expect(() => normalizeFactoryLimits({ limits: {} }, NOW)).toThrow("this Factory plan reports no usage windows");
  });

  test("no key asks for one, and nothing is fetched", async () => {
    const { fetch, calls } = factoryFetch({});
    await expect(runLimits(droid, { now: NOW, credential: null }, ioOf({ fetch }))).rejects.toMatchObject({ status: "needs-key" });
    expect(calls).toEqual([]);
  });

  test("the key goes only to Factory, and a matching login verifies the account", async () => {
    const { fetch, calls } = factoryFetch({ whoami: { userId: "user-a", orgId: "org-a" }, billing: FACTORY_BILLING });
    const readFile = (path: string) => (path === "/home/test/.factory/org-managed-settings.cache.json" ? LOGIN : null);
    const limits = await runLimits(droid, { now: NOW, credential: KEY }, ioOf({ fetch, readFile }));
    expect(limits.account).toBe("verified");
    expect(calls.map((c) => c.url).sort()).toEqual([`${FACTORY_API}/api/billing/limits`, `${FACTORY_API}/api/cli/whoami`]);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${KEY}`)).toBe(true);
  });

  test("a key for another user or another organization is refused", async () => {
    const readFile = () => LOGIN;
    for (const whoami of [{ userId: "user-b", orgId: "org-a" }, { userId: "user-a", orgId: "org-b" }]) {
      const { fetch } = factoryFetch({ whoami, billing: FACTORY_BILLING });
      await expect(runLimits(droid, { now: NOW, credential: KEY }, ioOf({ fetch, readFile }))).rejects.toMatchObject({
        status: "account-mismatch",
      });
    }
  });

  test("no readable login leaves the account unchecked, not refused", async () => {
    const { fetch } = factoryFetch({ whoami: { userId: "user-b", orgId: "org-b" }, billing: FACTORY_BILLING });
    for (const readFile of [() => null, () => "not json", () => JSON.stringify({ userId: "user-a" })]) {
      const limits = await runLimits(droid, { now: NOW, credential: KEY }, ioOf({ fetch, readFile }));
      expect(limits.account).toBe("unchecked");
    }
  });

  test("a rejected key asks for a new one; other failures say what happened", async () => {
    await expect(
      runLimits(droid, { now: NOW, credential: KEY }, ioOf({ fetch: factoryFetch({ status: 401 }).fetch })),
    ).rejects.toMatchObject({ status: "needs-key", message: "Factory rejected the API key. Replace it in Settings." });
    await expect(
      runLimits(droid, { now: NOW, credential: KEY }, ioOf({ fetch: factoryFetch({ status: 503 }).fetch })),
    ).rejects.toMatchObject({ status: "error", message: "the Factory API answered 503" });
    await expect(runLimits(droid, { now: NOW, credential: KEY }, ioOf())).rejects.toThrow("could not reach Factory: no network in tests");
  });
});

describe("the Factory key", () => {
  test("Settings wins over the environment; FACTORY_API_KEY over DROID_API_KEY", () => {
    expect(factoryKey({ factoryApiKey: "a" }, { FACTORY_API_KEY: "b" })).toEqual({ key: "a", source: "settings" });
    expect(factoryKey({}, { FACTORY_API_KEY: "b", DROID_API_KEY: "c" })).toEqual({ key: "b", source: "environment" });
    expect(factoryKey({}, { DROID_API_KEY: "c" })).toEqual({ key: "c", source: "environment" });
    expect(factoryKey({}, {})).toBeNull();
  });
});

describe("HarnessLimitsCache", () => {
  function counting() {
    let reads = 0;
    let fail = false;
    const spawnOnce = () => {
      reads++;
      if (fail) return { exitCode: 1, stdout: "", stderr: "boom" };
      return { exitCode: 0, stdout: JSON.stringify({ result: CLAUDE_REPORT }), stderr: "" };
    };
    return { spawnOnce, reads: () => reads, failNext: (v: boolean) => (fail = v) };
  }

  test("lists only harnesses that declare a read, and serves a second poll from the cache", async () => {
    const c = counting();
    let now = NOW.getTime();
    const cache = new HarnessLimitsCache({ spawnOnce: c.spawnOnce, which: (bin) => bin, env: {}, now: () => new Date(now) });
    const adapters = { claude, cursor: BUILTIN_ADAPTERS.cursor! };
    const first = await cache.read({}, adapters);
    expect(first.map((e) => [e.name, e.status, e.cached])).toEqual([["claude", "ok", false]]);
    const second = await cache.read({}, adapters);
    expect(second[0]!.cached).toBe(true);
    expect(c.reads()).toBe(1);
    await cache.read({}, adapters, { refresh: true });
    expect(c.reads()).toBe(2);
    now += 61_000;
    await cache.read({}, adapters);
    expect(c.reads()).toBe(3);
  });

  test("concurrent polls share one read, and a failure is never cached", async () => {
    const c = counting();
    const cache = new HarnessLimitsCache({ spawnOnce: c.spawnOnce, which: (bin) => bin, env: {} });
    await Promise.all([cache.read({}, { claude }), cache.read({}, { claude })]);
    expect(c.reads()).toBe(1);
    c.failNext(true);
    const failed = await cache.read({}, { claude }, { refresh: true });
    expect(failed[0]).toMatchObject({ status: "error", limits: null });
    c.failNext(false);
    const again = await cache.read({}, { claude });
    expect(again[0]).toMatchObject({ status: "ok", cached: false });
  });

  test("a harness that is not installed is unavailable, and a changed key is a fresh read", async () => {
    const { fetch, calls } = factoryFetch({ whoami: {}, billing: FACTORY_BILLING });
    const missing = new HarnessLimitsCache({ fetch, which: () => null, env: {} });
    expect((await missing.read({ factoryApiKey: KEY }, { droid }))[0]).toMatchObject({
      status: "unavailable",
      message: "droid is not installed on this machine",
    });
    expect(calls).toEqual([]);

    const cache = new HarnessLimitsCache({ fetch, which: (bin) => bin, env: {} });
    await cache.read({ factoryApiKey: KEY }, { droid });
    const hit = await cache.read({ factoryApiKey: KEY }, { droid });
    expect(hit[0]!.cached).toBe(true);
    const changed = await cache.read({ factoryApiKey: `${KEY}-2` }, { droid });
    expect(changed[0]!.cached).toBe(false);
    // the entry never carries the key
    expect(JSON.stringify(changed)).not.toContain(KEY);
  });

  test("a read that hangs times out as a named error", async () => {
    const cache = new HarnessLimitsCache({
      spawnOnce: (_cmd, opts) =>
        new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("killed")))),
      which: (bin) => bin,
      env: {},
      timeoutMs: 20,
    });
    expect((await cache.read({}, { claude }))[0]).toMatchObject({
      status: "error",
      message: "the claude limits read timed out after 0.02s",
    });
  });
});

describe("wisp limits output", () => {
  test("resets count down, flooring", () => {
    expect(resetsIn(null, NOW)).toBe("");
    expect(resetsIn("2026-09-25T01:00:00Z", NOW)).toBe("resets now");
    expect(resetsIn("2026-09-25T02:12:30Z", NOW)).toBe("resets in 12m");
    expect(resetsIn("2026-09-25T03:30:00Z", NOW)).toBe("resets in 1h 30m");
    expect(resetsIn("2026-09-28T06:00:00Z", NOW)).toBe("resets in 3d 4h");
  });

  test("one pool needs no heading, droid's two do, and a failure prints its reason", () => {
    const lines = limitsLines(
      {
        harnesses: [
          {
            name: "claude",
            status: "ok",
            limits: parseClaudeUsage(CLAUDE_REPORT, NOW),
            message: null,
            fetchedAt: NOW.toISOString(),
            cached: false,
          },
          {
            name: "droid",
            status: "ok",
            limits: { ...normalizeFactoryLimits(FACTORY_BILLING, NOW), account: "unchecked" },
            message: null,
            fetchedAt: NOW.toISOString(),
            cached: false,
          },
          { name: "codex", status: "unavailable", limits: null, message: "codex is not installed on this machine", fetchedAt: NOW.toISOString(), cached: false },
        ],
      },
      NOW,
    );
    expect(lines).toEqual([
      "claude",
      "  5h         ███░░░░░░░  33% used  resets in 3h 49m",
      "  7d         █████░░░░░  51% used  resets in 5d 1h",
      "  Opus       ░░░░░░░░░░   0% used  resets in 5d 2h",
      "droid",
      "  standard",
      "    5h         █░░░░░░░░░  13% used  resets in 2h 30m",
      "    weekly     ████░░░░░░  40% used  resets in 3d 22h",
      "    monthly    ███████░░░  70% used  resets in 5d 22h",
      "  core",
      "    5h         ░░░░░░░░░░   0% used",
      "    weekly     ░░░░░░░░░░   0% used",
      "    monthly    █░░░░░░░░░   5% used  resets in 5d 22h",
      "  not checked against droid's login",
      "codex  codex is not installed on this machine",
    ]);
  });
});

describe("GET /api/harness-limits", () => {
  const cfg = { token: "t", repos: [], harnessDefaults: {} } as unknown as WispConfig;
  const call = (path: string, cache: HarnessLimitsCache) => {
    const url = new URL(`http://127.0.0.1${path}`);
    return route(new Request(url), url, url.pathname, cfg, { claude, cursor: BUILTIN_ADAPTERS.cursor! }, undefined, undefined, undefined, undefined, undefined, undefined, cache);
  };

  test("answers every harness with a limits read, and refresh=1 skips the cache", async () => {
    let reads = 0;
    const cache = new HarnessLimitsCache({
      spawnOnce: () => {
        reads++;
        return { exitCode: 0, stdout: JSON.stringify({ result: CLAUDE_REPORT }), stderr: "" };
      },
      which: (bin) => bin,
      env: {},
    });
    const first = (await (await call("/api/harness-limits", cache)).json()) as { harnesses: { name: string; status: string }[] };
    expect(first.harnesses.map((h) => [h.name, h.status])).toEqual([["claude", "ok"]]);
    await call("/api/harness-limits", cache);
    expect(reads).toBe(1);
    await call("/api/harness-limits?refresh=1", cache);
    expect(reads).toBe(2);
  });
});
