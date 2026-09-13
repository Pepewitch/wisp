/**
 * The daemon's skill-discovery machinery (v0.3 A4): the cache that keeps a
 * palette open from paying droid's session-open latency (~10–12s and the
 * user's real MCP servers, SP1/SP2) per render. Mirrors probes.ts's posture
 * exactly: timeout-bounded, cached per task, failures never cached — a
 * discovery that cannot run answers with a named error, never a hardcoded
 * list that rots.
 *
 * What is deliberately NOT here: the harness knowledge (that is
 * adapters/skills.ts's SKILL_STRATEGIES) and a turn (discovery writes no turn
 * row, fires no transition, emits no outbox event).
 */
import {
  discoverSkills,
  ProbeError,
  type AdapterDef,
  type ProbeIo,
  type SkillDiscoveryResult,
} from "./adapters";
import { bunProbeSpawn, bunRpcFactory } from "./probes";
import { TaskCacheEntries } from "./task-cache";
import type { Task } from "./types";

export const SKILL_TIMEOUT_MS = 30_000; // droid's session open alone is ~10–12s (SP1)
export const SKILL_CACHE_TTL_MS = 120_000; // the probe TTL — a second ask is a second process otherwise

/** What the route answers with: the list, when it was taken, and whether the cache served it. */
export interface SkillAnswer {
  result: SkillDiscoveryResult;
  probedAt: string;
  cached: boolean;
}

export interface TaskSkillCacheOptions {
  spawnOnce?: ProbeIo["spawnOnce"];
  openRpc?: ProbeIo["openRpc"];
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * The daemon-owned skill cache. Same three rules the probe cache lives by,
 * for the same reason (SP2: enumeration is free in tokens and expensive in
 * wall clock): a re-ask inside the TTL serves the previous list and says so,
 * a stampede shares one in-flight discovery, and a failure is NOT cached —
 * the next ask retries.
 */
export class TaskSkillCache {
  private readonly entries: TaskCacheEntries<SkillDiscoveryResult>;
  private readonly inFlight = new Map<
    string,
    {
      promise: Promise<SkillAnswer>;
      controller: AbortController;
      state: { deleted: boolean };
    }
  >();
  private readonly io: ProbeIo;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: TaskSkillCacheOptions = {}) {
    this.io = { spawnOnce: options.spawnOnce ?? bunProbeSpawn, openRpc: options.openRpc ?? bunRpcFactory };
    this.timeoutMs = options.timeoutMs ?? SKILL_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.entries = new TaskCacheEntries(options.ttlMs ?? SKILL_CACHE_TTL_MS);
  }

  skills(task: Task, def: AdapterDef): Promise<SkillAnswer> {
    const key = task.id;
    const hit = this.entries.get(key, this.now().getTime());
    if (hit) {
      return Promise.resolve({ result: hit.value, probedAt: new Date(hit.at).toISOString(), cached: true });
    }
    const running = this.inFlight.get(key);
    if (running) return running.promise;

    const controller = new AbortController();
    const state = { deleted: false };
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new ProbeError(`the ${task.harness} skill discovery timed out after ${this.timeoutMs / 1000}s`, 504);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });

    const attempt = Promise.race([
      discoverSkills(def, {
        sessionId: task.session_id,
        cwd: task.worktree_path ?? task.repo_path,
        initSkills: parseInitSkills(task.skills_json),
        signal: controller.signal,
      }, this.io),
      timedOut,
    ])
      .then((result): SkillAnswer => {
        const at = this.now();
        if (!state.deleted) this.entries.set(task.id, key, result, at.getTime());
        return { result, probedAt: at.toISOString(), cached: false };
      })
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
        controller.abort(); // a finished discovery never leaves its child alive
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, { promise: attempt, controller, state });
    return attempt;
  }

  deleteTask(taskId: string): void {
    this.entries.deleteTask(taskId);
    const flight = this.inFlight.get(taskId);
    if (!flight) return;
    flight.state.deleted = true;
    flight.controller.abort(new ProbeError("the task was permanently deleted", 410));
  }
}

/** NULL and "[]" are different claims and stay different; a corrupt blob is no list at all, never a crash. */
function parseInitSkills(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null;
  } catch {
    return null;
  }
}
