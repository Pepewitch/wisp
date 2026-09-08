/**
 * The daemon's compaction runner (v0.3 A5). Deliberately NOT a cache:
 * compaction is an action with a side effect (droid mints a new session),
 * so a second click must run a second compaction, never serve the first
 * one's result. What it DOES share with the probe/skill caches is the
 * timeout posture and in-flight dedup — two clicks in the same second are
 * ONE compaction, because two compactors racing the same session is the
 * dishonest kind of concurrency.
 *
 * What is deliberately NOT here: the harness knowledge (that is
 * adapters/compact.ts's COMPACT_STRATEGIES) and the session_id replacement
 * (that is the route's — a field update on the task row).
 */
import { ProbeError, runCompact, type AdapterDef, type CompactResult, type ProbeIo } from "./adapters";
import { bunProbeSpawn, bunRpcFactory } from "./probes";
import type { Task } from "./types";

export const COMPACT_TIMEOUT_MS = 60_000; // summarizing a long session is slower than reading one

export interface TaskCompactorOptions {
  spawnOnce?: ProbeIo["spawnOnce"];
  openRpc?: ProbeIo["openRpc"];
  timeoutMs?: number;
}

export class TaskCompactor {
  private readonly inFlight = new Map<string, Promise<CompactResult>>();
  private readonly io: ProbeIo;
  private readonly timeoutMs: number;

  constructor(options: TaskCompactorOptions = {}) {
    this.io = { spawnOnce: options.spawnOnce ?? bunProbeSpawn, openRpc: options.openRpc ?? bunRpcFactory };
    this.timeoutMs = options.timeoutMs ?? COMPACT_TIMEOUT_MS;
  }

  compact(task: Task, def: AdapterDef): Promise<CompactResult> {
    const running = this.inFlight.get(task.id);
    if (running) return running;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProbeError(`the ${task.harness} compaction timed out after ${this.timeoutMs / 1000}s`, 504));
      }, this.timeoutMs);
    });

    const attempt = Promise.race([
      runCompact(
        def,
        { sessionId: task.session_id, cwd: task.worktree_path ?? task.repo_path, signal: controller.signal },
        this.io,
      ),
      timedOut,
    ]).finally(() => {
      if (timeout !== null) clearTimeout(timeout);
      controller.abort(); // a finished compaction never leaves its child alive
      this.inFlight.delete(task.id);
    });
    this.inFlight.set(task.id, attempt);
    return attempt;
  }
}
