import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  PROBE_STRATEGIES,
  ProbeError,
  probeCommands,
  runProbe,
  type AdapterDef,
  type ProbeIo,
  type ProbeSpawnFn,
  type RpcFactory,
  type RpcSession,
} from "../src/adapters";
import { TaskProbeCache } from "../src/probes";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, type Task } from "../src/store";
import type { SpawnResult } from "../src/doctor";

const claude = BUILTIN_ADAPTERS.claude!;
const droid = BUILTIN_ADAPTERS.droid!;
const codex = BUILTIN_ADAPTERS.codex!;

/** A scripted one-shot spawn that records its argv and answers with canned output. */
function scriptedSpawn(result: SpawnResult): { spawn: ProbeSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (cmd) => {
      calls.push(cmd);
      return result;
    },
  };
}

/** A scripted RPC peer: method → result, calls recorded, close marked. */
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
          if (!(method in table)) return Promise.reject(new ProbeError(`the harness rejected the probe: unknown method ${method}`));
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

function ioOf(partial: Partial<ProbeIo>): ProbeIo {
  return {
    spawnOnce: partial.spawnOnce ?? (() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
    openRpc: partial.openRpc ?? scriptedRpc({}).openRpc,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

describe("probe strategy wiring (A3)", () => {
  test("the builtins declare exactly the reads SP1 proved", () => {
    expect(probeCommands(claude)).toEqual(["context", "usage"]);
    expect(probeCommands(droid)).toEqual(["context"]); // no credits/usage RPC exists
    expect(probeCommands(codex)).toEqual(["usage"]); // no per-thread context read exists
    const noprobe: AdapterDef = { bin: "x", exec: [], parse: { format: "text" } };
    expect(probeCommands(noprobe)).toEqual([]);
  });

  test("runProbe is loud about an unknown strategy on a hand-built def", async () => {
    const bad: AdapterDef = { bin: "x", exec: [], parse: { format: "text" }, probe: "nope" };
    const err = await runProbe(bad, "context", { sessionId: "s", cwd: null }, ioOf({})).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect(message(err)).toBe(
      "adapter probe strategy 'nope' is not a known strategy (known: print-slash, factory-jsonrpc, codex-app-server)",
    );
    expect((err as ProbeError).status).toBe(500);
  });
});

describe("print-slash (claude)", () => {
  const RESULT = '{"type":"result","session_id":"s-1","result":"## Context Usage\\n\\n**Tokens:** 13.3k / 1m"}\n';

  test("the slash command rides the adapter's own argv with the session resumed", async () => {
    const { spawn, calls } = scriptedSpawn({ exitCode: 0, stdout: RESULT, stderr: "" });
    const report = await runProbe(claude, "context", { sessionId: "s-1", cwd: "/tmp/wt" }, ioOf({ spawnOnce: spawn }));
    expect(report).toEqual({ format: "markdown", text: "## Context Usage\n\n**Tokens:** 13.3k / 1m" });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("s-1");
    expect(argv[argv.length - 1]).toBe("/context"); // the command IS the prompt
  });

  test("no session is a 409 with the honest reason, not a spawn", async () => {
    const { spawn, calls } = scriptedSpawn({ exitCode: 0, stdout: RESULT, stderr: "" });
    const err = await runProbe(claude, "usage", { sessionId: null, cwd: null }, ioOf({ spawnOnce: spawn })).catch(
      (e) => e,
    );
    expect((err as ProbeError).status).toBe(409);
    expect(message(err)).toBe("no session yet — the first turn creates one");
    expect(calls).toHaveLength(0);
  });

  test("a result-less stream is a named 502, never a fabricated report", async () => {
    const { spawn } = scriptedSpawn({ exitCode: 1, stdout: "", stderr: "unknown option --resume" });
    const err = await runProbe(claude, "context", { sessionId: "s-1", cwd: null }, ioOf({ spawnOnce: spawn })).catch(
      (e) => e,
    );
    expect((err as ProbeError).status).toBe(502);
    expect(message(err)).toBe("claude answered /context with no report (exit 1): unknown option --resume");
  });
});

describe("factory-jsonrpc (droid)", () => {
  // the shape SP1 captured verbatim from droid.get_context_breakdown
  const BREAKDOWN = {
    modelId: "claude-opus-5",
    modelDisplayName: "Opus 5",
    contextBudget: 250000,
    usedTokens: 11981,
    freeTokens: 238019,
    categories: [
      { name: "System prompt", tokens: 1330 },
      { name: "Messages", tokens: 0 },
    ],
    skills: [{ name: "find-skills", location: "personal", tokens: 79 }],
    mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
  };

  test("load the task's session, read the breakdown, close — numbers copied, nothing invented", async () => {
    const { openRpc, calls, state } = scriptedRpc({
      "droid.load_session": { sessionId: "s-9" },
      "droid.get_context_breakdown": BREAKDOWN,
    });
    const report = await runProbe(droid, "context", { sessionId: "s-9", cwd: "/tmp/wt" }, ioOf({ openRpc }));
    expect(calls).toEqual(["droid.load_session", "droid.get_context_breakdown"]);
    expect(state.closed).toBe(true); // a read never leaves the harness session running
    expect(report.format).toBe("context");
    if (report.format !== "context") return;
    expect(report.context).toEqual({
      model: "Opus 5",
      budgetTokens: 250000,
      usedTokens: 11981,
      freeTokens: 238019,
      categories: [
        { name: "System prompt", tokens: 1330 },
        { name: "Messages", tokens: 0 },
      ],
      skills: [{ name: "find-skills", tokens: 79 }], // location is the harness's business, not the panel's
      mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
    });
  });

  test("no session is a 409 before any process opens", async () => {
    const { openRpc, calls } = scriptedRpc({});
    const err = await runProbe(droid, "context", { sessionId: null, cwd: null }, ioOf({ openRpc })).catch((e) => e);
    expect((err as ProbeError).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("the peer is closed even when the read fails", async () => {
    const { openRpc, state } = scriptedRpc({ "droid.load_session": { sessionId: "s-9" } }); // breakdown method missing
    const err = await runProbe(droid, "context", { sessionId: "s-9", cwd: null }, ioOf({ openRpc })).catch((e) => e);
    expect(message(err)).toContain("droid.get_context_breakdown");
    expect(state.closed).toBe(true);
  });

  test("a changed payload shape fails loudly, not silently empty", async () => {
    const { openRpc } = scriptedRpc({
      "droid.load_session": {},
      "droid.get_context_breakdown": ["not", "an", "object"],
    });
    const err = await runProbe(droid, "context", { sessionId: "s-9", cwd: null }, ioOf({ openRpc })).catch((e) => e);
    expect(message(err)).toContain("context breakdown");
  });
});

describe("codex-app-server (codex)", () => {
  // the shapes SP1 captured from account/rateLimits/read + account/usage/read
  const RATE_LIMITS = {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787997484 },
      secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: 1788455752 },
      credits: { hasCredits: true, unlimited: false, balance: null },
      planType: "team",
    },
  };
  const USAGE = { summary: { lifetimeTokens: 4357063208, currentStreakDays: 12 }, dailyUsageBuckets: [] };

  test("initialize, two account reads, close — no session required", async () => {
    const { openRpc, calls, state } = scriptedRpc({
      initialize: { userAgent: "wisp" },
      "account/rateLimits/read": RATE_LIMITS,
      "account/usage/read": USAGE,
    });
    const report = await runProbe(codex, "usage", { sessionId: null, cwd: null }, ioOf({ openRpc }));
    expect(calls).toContain("initialize");
    expect(calls).toContain("account/rateLimits/read");
    expect(calls).toContain("account/usage/read");
    expect(state.closed).toBe(true);
    expect(report.format).toBe("usage");
    if (report.format !== "usage") return;
    expect(report.usage).toEqual({
      planType: "team",
      primary: { usedPercent: 0, windowMins: 300, resetsAt: new Date(1787997484 * 1000).toISOString() },
      secondary: { usedPercent: 47, windowMins: 10080, resetsAt: new Date(1788455752 * 1000).toISOString() },
      credits: { hasCredits: true, unlimited: false, balance: null },
      lifetimeTokens: 4357063208,
    });
  });
});

describe("TaskProbeCache", () => {
  function probeTask(harness = "claude", session: string | null = "s-1"): Task {
    const task = createTask({
      id: newTaskId(),
      title: "probe cache test",
      repo_path: "/tmp/repo",
      harness,
      model: null,
      slot: freeSlot(),
    });
    if (session) setTaskFields(task.id, { session_id: session });
    // re-read: createTask's return is the creation-time snapshot (session_id
    // still null), and the probe reads the row we hand it
    return getTask(task.id)!;
  }

  const MD_RESULT = '{"type":"result","session_id":"s-1","result":"## report"}\n';

  test("a second click inside the TTL is served cached and spawns nothing", async () => {
    const { spawn, calls } = scriptedSpawn({ exitCode: 0, stdout: MD_RESULT, stderr: "" });
    const cache = new TaskProbeCache({ spawnOnce: spawn, ttlMs: 60_000 });
    const task = probeTask();
    const first = await cache.probe(task, claude, "context");
    const second = await cache.probe(task, claude, "context");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.probedAt).toBe(first.probedAt);
    expect(calls).toHaveLength(1);
  });

  test("different commands and different tasks cache apart", async () => {
    const { spawn, calls } = scriptedSpawn({ exitCode: 0, stdout: MD_RESULT, stderr: "" });
    const cache = new TaskProbeCache({ spawnOnce: spawn, ttlMs: 60_000 });
    const a = probeTask();
    const b = probeTask();
    await cache.probe(a, claude, "context");
    await cache.probe(a, claude, "usage");
    await cache.probe(b, claude, "context");
    expect(calls).toHaveLength(3);
  });

  test("a failure is NOT cached — the next click retries", async () => {
    let calls = 0;
    const spawn: ProbeSpawnFn = () => {
      calls += 1;
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
    };
    const cache = new TaskProbeCache({ spawnOnce: spawn });
    const task = probeTask();
    const err = await cache.probe(task, claude, "context").catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    await cache.probe(task, claude, "context").catch(() => {});
    expect(calls).toBe(2);
  });

  test("a stampede of clicks shares one in-flight probe", async () => {
    let calls = 0;
    const spawn: ProbeSpawnFn = async () => {
      calls += 1;
      await Bun.sleep(30);
      return { exitCode: 0, stdout: MD_RESULT, stderr: "" };
    };
    const cache = new TaskProbeCache({ spawnOnce: spawn });
    const task = probeTask();
    const [a, b] = await Promise.all([cache.probe(task, claude, "context"), cache.probe(task, claude, "context")]);
    expect(calls).toBe(1);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
  });

  test("a hung probe dies at the timeout with a named 504, and its signal fires", async () => {
    let aborted = false;
    const spawn: ProbeSpawnFn = (_cmd, opts) => {
      opts.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<SpawnResult>(() => {}); // never answers
    };
    const cache = new TaskProbeCache({ spawnOnce: spawn, timeoutMs: 40 });
    const task = probeTask();
    const err = await cache.probe(task, claude, "context").catch((e) => e);
    expect((err as ProbeError).status).toBe(504);
    expect(message(err)).toContain("timed out");
    expect(aborted).toBe(true);
  });

  test("a finished probe aborts its child — nothing outlives the read", async () => {
    let aborted = false;
    const spawn: ProbeSpawnFn = (_cmd, opts) => {
      opts.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return Promise.resolve({ exitCode: 0, stdout: MD_RESULT, stderr: "" });
    };
    const cache = new TaskProbeCache({ spawnOnce: spawn });
    await cache.probe(probeTask(), claude, "context");
    expect(aborted).toBe(true);
  });
});

describe("probe validation (A3)", () => {
  test("probe must name a builtin probe strategy", async () => {
    const { validateAdapters } = await import("../src/adapters");
    const base = { bin: "x", exec: [], parse: { format: "text" } };
    expect(() => validateAdapters({ foo: { ...base, probe: "nope" } })).toThrow(
      'adapters.json: adapter \'foo\'.probe must name a builtin probe strategy (known: print-slash, factory-jsonrpc, codex-app-server), got "nope"',
    );
    expect(() => validateAdapters({ foo: { ...base, probe: 7 } })).toThrow(
      "adapters.json: adapter 'foo'.probe must name a builtin probe strategy (known: print-slash, factory-jsonrpc, codex-app-server), got number",
    );
    expect(validateAdapters({ foo: { ...base, probe: "print-slash" } }).foo!.probe).toBe("print-slash");
  });

  test("every builtin's probe strategy resolves", () => {
    for (const [name, def] of Object.entries(BUILTIN_ADAPTERS)) {
      if (def.probe) expect(PROBE_STRATEGIES[def.probe], name).toBeTruthy();
    }
  });
});
