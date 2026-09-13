/**
 * The daemon's out-of-turn read machinery (v0.3 A3): production process IO
 * for the named strategies in adapters/probe.ts, plus the cache that keeps a
 * click from spinning up a harness session per press. Mirrors
 * model-probes.ts's posture: timeout/output-bounded, cached, and honest on
 * failure — a probe that cannot run answers with a named error, never a
 * fabricated report.
 *
 * What is deliberately NOT here: a turn. A probe writes no turn row, fires no
 * transition, and emits no outbox event (the plan's A3: routing a read
 * through /send would lie about the task's state).
 */
import {
  runProbe,
  ProbeError,
  type AdapterDef,
  type ProbeCommand,
  type ProbeIo,
  type ProbeReport,
  type ProbeSpawnFn,
  type RpcFactory,
  type RpcSession,
} from "./adapters";
import type { SpawnResult } from "./doctor";
import { assertExecutableAllowed } from "./launch-policy";
import { CappedOutput } from "./capped-output";
import { CommandGroup } from "./command-group";
import { JsonLineBuffer } from "./adapters/live/json-lines";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ERROR_BYTES, runBoundedCommand } from "./subprocess";
import { TaskCacheEntries } from "./task-cache";
import type { Task } from "./types";

export const PROBE_TIMEOUT_MS = 30_000; // droid's session open alone is ~10–12s (SP1)
export const PROBE_CACHE_TTL_MS = 120_000;
export const PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const PROBE_RPC_MAX_FRAME_CHARS = 2 * 1024 * 1024;
export const PROBE_RPC_MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;

/**
 * droid's envelope constant, read out of the 0.213.0 binary. A zero-token
 * transport probe confirmed 0.213.0 accepts this version and echoes it on
 * responses (the prior 1.189.0 is still accepted for compatibility). droid
 * rejects bare JSON-RPC with -32700, so a probe request must carry it. It
 * WILL move with droid releases — a moved version must surface as a probe
 * error naming the protocol, not as a silently empty report.
 */
export const FACTORY_PROTOCOL_VERSION = "1.204.0";

/** Production one-shot process runner: spawn with a cwd and bounded output. */
export const bunProbeSpawn: ProbeSpawnFn = async (cmd, opts): Promise<SpawnResult> => {
  assertExecutableAllowed(cmd, "harness probe", opts.cwd);
  return runBoundedCommand({
    cmd,
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBytes: PROBE_MAX_BYTES,
    maxErrorBytes: DEFAULT_MAX_ERROR_BYTES,
  }, "harness probe");
};

/**
 * Production line-delimited JSON-RPC over a child's stdio. A response is
 * matched to its caller by id; notifications are skipped (droid floods them:
 * settings, MCP status) EXCEPT when someone is waiting for one — codex's
 * compaction finishes as a turn/completed notification, and A5's honest
 * "it finished" is exactly that event. The factory envelope carries string
 * ids and the version fields; codex's app-server is plain JSON-RPC with
 * numeric ids (both per the SP1 transcripts). Aborting — the probe timed
 * out — kills the child and rejects every pending call and waiter.
 */
/** A match predicate that throws must not take the protocol reader down with it. */
function safeMatch(match: (p: unknown) => boolean, params: unknown): boolean {
  try {
    return match(params);
  } catch {
    return false;
  }
}

export const bunRpcFactory: RpcFactory = (cmd, opts): RpcSession => {
  assertExecutableAllowed(cmd, "harness rpc session", opts.cwd);
  const child = Bun.spawn({ cmd, cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  // Bun does not finalize pipe EOF until the exit promise is observed.
  void child.exited.catch(() => {});
  const group = new CommandGroup(child);
  const stdout = child.stdout.getReader();
  const stderr = new CappedOutput(child.stderr, DEFAULT_MAX_ERROR_BYTES);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const waiters: {
    method: string;
    match?: (params: unknown) => boolean;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }[] = [];
  let nextId = 0;
  let closed = false;
  let closedError = new ProbeError("the probe channel is closed");

  const failAll = (reason: string | ProbeError): void => {
    const error = reason instanceof ProbeError ? reason : new ProbeError(reason);
    for (const [, p] of pending) p.reject(error);
    pending.clear();
    for (const w of waiters) w.reject(error);
    waiters.length = 0;
  };

  const close = (reason: string | ProbeError = "the probe channel is closed"): void => {
    if (closed) return;
    closed = true;
    closedError = reason instanceof ProbeError ? reason : new ProbeError(reason);
    failAll(closedError);
    try { child.stdin.end(); } catch { /* already gone */ }
    void stdout.cancel().catch(() => {});
    stderr.close();
    void (async () => {
      try {
        if (child.exitCode !== null || child.signalCode !== null) await group.captureExit();
        if (!await group.inspect("SIGKILL")) {
          for (let attempt = 0; attempt < 20 && !await group.inspect(); attempt++) await Bun.sleep(50);
        }
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      } finally {
        group.close();
      }
    })();
  };

  const signal = opts.signal;
  const abort = (): void => close(signal?.reason instanceof ProbeError ? signal.reason : "the probe channel is closed");
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  void (async () => {
    const decoder = new TextDecoder();
    const frameLimit = `the harness exceeded the probe channel's ${PROBE_RPC_MAX_FRAME_CHARS}-character frame limit`;
    const lines = new JsonLineBuffer({
      maxFrameChars: PROBE_RPC_MAX_FRAME_CHARS,
      onOverflow: () => { throw new ProbeError(frameLimit); },
      onDrop: () => { throw new ProbeError(frameLimit); },
    });
    let bytes = 0;
    let failure: string | null = null;
    try {
      for (;;) {
        const { value: chunk, done } = await stdout.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > PROBE_RPC_MAX_OUTPUT_BYTES) {
          failure = `the harness exceeded the probe channel's ${PROBE_RPC_MAX_OUTPUT_BYTES}-byte output budget`;
          break;
        }
        for (const raw of lines.push(decoder.decode(chunk, { stream: true }))) {
          const line = raw.trim();
          if (!line) continue;
          let msg: { id?: unknown; result?: unknown; error?: unknown };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            continue; // a non-JSON line on a protocol channel is noise, not an answer
          }
          const key = msg?.id === undefined || msg.id === null ? null : String(msg.id);
          if (key === null) {
            // a notification: offer it to each waiter in turn — first match
            // consumes it, the rest keep waiting
            const n = msg as { method?: unknown; params?: unknown };
            if (typeof n.method === "string") {
              const i = waiters.findIndex(
                (w) => w.method === n.method && (!w.match || safeMatch(w.match, n.params)),
              );
              if (i >= 0) waiters.splice(i, 1)[0]!.resolve(n.params);
            }
            continue;
          }
          const p = pending.get(key);
          if (!p) continue; // a response to a call we stopped waiting on
          pending.delete(key);
          if (msg.error !== undefined && msg.error !== null) {
            const e = msg.error as { message?: unknown };
            p.reject(
              new ProbeError(
                `the harness rejected the probe${typeof e.message === "string" ? `: ${e.message}` : ""}`,
              ),
            );
          } else {
            p.resolve(msg.result);
          }
        }
      }
    } catch (error) {
      if (!closed) {
        failure = error instanceof ProbeError
          ? error.message
          : `the harness probe channel failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      // the stream ended — normal close or a crash: nobody gets an answer late
      const stderrLine = stderr.text.trim().split("\n")[0] ?? "";
      const reason = failure ?? `the harness closed the probe channel${stderrLine ? `: ${stderrLine}` : ""}`;
      if (!closed) close(reason);
      stdout.releaseLock();
    }
  })();

  return {
    call(method, params) {
      if (closed) return Promise.reject(closedError);
      const id = ++nextId;
      const frame =
        opts.envelope === "factory"
          ? {
              jsonrpc: "2.0",
              type: "request",
              factoryApiVersion: "1.0.0",
              factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
              id: String(id),
              method,
              params,
            }
          : { jsonrpc: "2.0", id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify(frame)}\n`);
          child.stdin.flush();
        } catch (e) {
          pending.delete(String(id));
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    onNotification(method, match) {
      if (closed) return Promise.reject(closedError);
      return new Promise((resolve, reject) => {
        waiters.push({ method, match, resolve, reject });
      });
    },
    close,
  };
};

/** What the route answers with: the report, when it was taken, and whether it was served from the click before. */
export interface ProbeAnswer {
  report: ProbeReport;
  probedAt: string;
  cached: boolean;
}

export interface TaskProbeCacheOptions {
  spawnOnce?: ProbeSpawnFn;
  openRpc?: RpcFactory;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * The daemon-owned probe cache. droid's read costs ~10–12s and spins up the
 * user's real MCP servers as a side effect of opening the session (SP1), so a
 * re-click inside the TTL serves the previous report and says so (`cached`),
 * and a stampede of clicks shares one in-flight probe. Failures are NOT
 * cached — the next click retries.
 */
export class TaskProbeCache {
  private readonly entries: TaskCacheEntries<ProbeReport>;
  private readonly inFlight = new Map<
    string,
    {
      taskId: string;
      promise: Promise<ProbeAnswer>;
      controller: AbortController;
      state: { deleted: boolean };
    }
  >();
  private readonly io: ProbeIo;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: TaskProbeCacheOptions = {}) {
    this.io = { spawnOnce: options.spawnOnce ?? bunProbeSpawn, openRpc: options.openRpc ?? bunRpcFactory };
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.entries = new TaskCacheEntries(options.ttlMs ?? PROBE_CACHE_TTL_MS);
  }

  probe(task: Task, def: AdapterDef, command: ProbeCommand): Promise<ProbeAnswer> {
    const key = `${task.id}:${command}`;
    const hit = this.entries.get(key, this.now().getTime());
    if (hit) {
      return Promise.resolve({ report: hit.value, probedAt: new Date(hit.at).toISOString(), cached: true });
    }
    const running = this.inFlight.get(key);
    if (running) return running.promise;

    const controller = new AbortController();
    const state = { deleted: false };
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new ProbeError(`the ${task.harness} probe timed out after ${this.timeoutMs / 1000}s`, 504);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });

    const attempt = Promise.race([
      runProbe(def, command, {
        sessionId: task.session_id,
        cwd: task.worktree_path ?? task.repo_path,
        signal: controller.signal,
      }, this.io),
      timedOut,
    ])
      .then((report): ProbeAnswer => {
        const at = this.now();
        if (!state.deleted) this.entries.set(task.id, key, report, at.getTime());
        return { report, probedAt: at.toISOString(), cached: false };
      })
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
        controller.abort(); // a finished probe never leaves its child alive
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, { taskId: task.id, promise: attempt, controller, state });
    return attempt;
  }

  deleteTask(taskId: string): void {
    this.entries.deleteTask(taskId);
    for (const flight of this.inFlight.values()) {
      if (flight.taskId !== taskId) continue;
      flight.state.deleted = true;
      flight.controller.abort(new ProbeError("the task was permanently deleted", 410));
    }
  }
}
