import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  COMPACT_STRATEGIES,
  ProbeError,
  runCompact,
  type AdapterDef,
  type ProbeIo,
  type RpcFactory,
  type RpcSession,
} from "../src/adapters";
import { TaskCompactor } from "../src/compacts";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";

/**
 * A5 unit tests — the compaction strategies and the compactor, with scripted
 * RPC peers. No real harness CLI is spawned here (and claude needs none at
 * all: its compact rides the ordinary turn path via compactPrompt).
 */

const claude = BUILTIN_ADAPTERS.claude!;
const droid = BUILTIN_ADAPTERS.droid!;
const codex = BUILTIN_ADAPTERS.codex!;

/** A scripted RPC peer whose onNotification resolves when the test says so. */
function scriptedRpc(
  table: Record<string, unknown>,
): {
  openRpc: RpcFactory;
  calls: string[];
  state: { closed: boolean };
  resolveWaiter: (params: unknown) => void;
} {
  const calls: string[] = [];
  const state = { closed: false };
  let waiter: { resolve: (v: unknown) => void } | null = null;
  return {
    calls,
    state,
    resolveWaiter: (params) => waiter?.resolve(params),
    openRpc: () => {
      const session: RpcSession = {
        call(method) {
          calls.push(method);
          if (!(method in table)) {
            return Promise.reject(new ProbeError(`the harness rejected the probe: unknown method ${method}`));
          }
          return Promise.resolve(table[method]);
        },
        onNotification(method) {
          calls.push(`wait:${method}`);
          return new Promise((resolve) => {
            waiter = { resolve };
          });
        },
        close() {
          state.closed = true;
        },
      };
      return session;
    },
  };
}

function ioOf(openRpc: RpcFactory): ProbeIo {
  return {
    spawnOnce: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    openRpc,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

describe("compact strategy wiring (A5)", () => {
  test("the builtins declare exactly what SP1 proved — and claude declares a prompt, not a strategy", () => {
    expect(droid.compact).toBe("factory-jsonrpc");
    expect(codex.compact).toBe("codex-app-server");
    expect(claude.compact).toBeUndefined();
    expect(claude.compactPrompt).toBe("/compact"); // an ordinary turn, recorded like any other
    expect(COMPACT_STRATEGIES["codex-app-server"]!.recordsTurn).toBe(true);
    expect(COMPACT_STRATEGIES["factory-jsonrpc"]!.recordsTurn).toBe(false);
  });

  test("runCompact is loud about an unknown strategy on a hand-built def", async () => {
    const bad: AdapterDef = { bin: "x", exec: [], parse: { format: "text" }, compact: "nope" };
    const err = await runCompact(bad, { sessionId: "s", cwd: null }, ioOf(scriptedRpc({}).openRpc)).catch((e) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect(message(err)).toBe(
      "adapter compact strategy 'nope' is not a known strategy (known: factory-jsonrpc, codex-app-server)",
    );
    expect((err as ProbeError).status).toBe(500);
  });
});

describe("factory-jsonrpc compact (droid)", () => {
  test("load the session, compact it, hand back the new session id and the count", async () => {
    const { openRpc, calls, state } = scriptedRpc({
      "droid.load_session": { sessionId: "s-1" },
      "droid.compact_session": { newSessionId: "s-2", removedCount: 3 },
    });
    const result = await runCompact(droid, { sessionId: "s-1", cwd: "/tmp/wt" }, ioOf(openRpc));
    expect(calls).toEqual(["droid.load_session", "droid.compact_session"]);
    expect(result).toEqual({ removedCount: 3, newSessionId: "s-2", note: null });
    expect(state.closed).toBe(true);
  });

  test("a result missing the new id is reported absent, never invented", async () => {
    const { openRpc } = scriptedRpc({
      "droid.load_session": {},
      "droid.compact_session": { removedCount: 1 },
    });
    const result = await runCompact(droid, { sessionId: "s-1", cwd: null }, ioOf(openRpc));
    expect(result.newSessionId).toBeNull();
    expect(result.removedCount).toBe(1);
  });

  test("no session is a 409 with the honest reason, not a spawn", async () => {
    const { openRpc, calls } = scriptedRpc({});
    const err = await runCompact(droid, { sessionId: null, cwd: null }, ioOf(openRpc)).catch((e) => e);
    expect((err as ProbeError).status).toBe(409);
    expect(message(err)).toBe("no session yet — compaction needs a session to compact; run a turn first");
    expect(calls).toHaveLength(0);
  });
});

describe("codex-app-server compact (codex)", () => {
  const TABLE = {
    initialize: {},
    "thread/resume": { thread: { id: "t-1" } },
    "thread/compact/start": {},
  };

  test("the ack is not completion: the strategy awaits turn/completed for OUR thread", async () => {
    const { openRpc, calls, state, resolveWaiter } = scriptedRpc(TABLE);
    const pending = runCompact(codex, { sessionId: "t-1", cwd: null }, ioOf(openRpc));
    // the waiter is registered BEFORE the start call, so a fast compaction can't race us
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["initialize", "thread/resume", "wait:turn/completed", "thread/compact/start"]);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    resolveWaiter({ threadId: "t-1", turn: { status: "completed" } });
    const result = await pending;
    expect(settled).toBe(true);
    expect(result).toEqual({
      removedCount: null, // codex doesn't say what it dropped
      newSessionId: null, // same thread, less context
      note: "codex recorded it as a turn in its own thread",
    });
    expect(state.closed).toBe(true);
  });

  test("a client without notification support reports the ack and says 'started'", async () => {
    const calls: string[] = [];
    const openRpc: RpcFactory = () => ({
      call(method) {
        calls.push(method);
        return Promise.resolve(TABLE[method as keyof typeof TABLE] ?? {});
      },
      // no onNotification — a minimal peer
      close() {},
    });
    const result = await runCompact(codex, { sessionId: "t-1", cwd: null }, ioOf(openRpc));
    expect(result.note).toBe("started — codex records it as a turn in its own thread");
    expect(calls).toEqual(["initialize", "thread/resume", "thread/compact/start"]);
  });

  test("no session is a 409, not a spawn", async () => {
    const { openRpc, calls } = scriptedRpc(TABLE);
    const err = await runCompact(codex, { sessionId: null, cwd: null }, ioOf(openRpc)).catch((e) => e);
    expect((err as ProbeError).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("TaskCompactor (A5)", () => {
  function task(harness = "droid", session: string | null = "s-1") {
    const t = createTask({
      id: newTaskId(),
      title: "compact task",
      repo_path: "/tmp/wisp-compact-repo",
      harness,
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(t.id, { session_id: session });
    // createTask returns the creation-time snapshot — the setTaskFields write
    // above is only visible in a fresh read
    return getTask(t.id)!;
  }

  test("a timeout is a 504 and aborts the child", async () => {
    let signalled = false;
    const compactor = new TaskCompactor({
      timeoutMs: 25,
      openRpc: (_cmd, opts) => {
        opts.signal?.addEventListener("abort", () => {
          signalled = true;
        });
        return {
          call: () => new Promise(() => {}), // never answers
          close() {},
        };
      },
    });
    const err = await compactor.compact(task(), droid).catch((e) => e);
    expect((err as ProbeError).status).toBe(504);
    expect(message(err)).toBe("the droid compaction timed out after 0.025s");
    expect(signalled).toBe(true);
  });

  test("two clicks in the same second are ONE compaction — deduped in flight, never cached", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const compactor = new TaskCompactor({
      openRpc: () => ({
        async call(method: string) {
          if (method === "droid.compact_session") {
            runs += 1;
            await gate;
            return { newSessionId: "s-2", removedCount: 3 };
          }
          return {};
        },
        close() {},
      }),
    });
    const t = task();
    const p1 = compactor.compact(t, droid);
    const p2 = compactor.compact(t, droid);
    expect(p2).toBe(p1); // the same in-flight promise — no second compaction races the session
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
    // and a click AFTER it finished runs a fresh compaction — an action is not a read
    await compactor.compact(t, droid);
    expect(runs).toBe(2);
  });
});
