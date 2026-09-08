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
  private readonly entries = new Map<string, { result: SkillDiscoveryResult; at: number }>();
  private readonly inFlight = new Map<string, Promise<SkillAnswer>>();
  private readonly io: ProbeIo;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(options: TaskSkillCacheOptions = {}) {
    this.io = { spawnOnce: options.spawnOnce ?? bunProbeSpawn, openRpc: options.openRpc ?? bunRpcFactory };
    this.timeoutMs = options.timeoutMs ?? SKILL_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? SKILL_CACHE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  skills(task: Task, def: AdapterDef): Promise<SkillAnswer> {
    const key = task.id;
    const hit = this.entries.get(key);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) {
      return Promise.resolve({ result: hit.result, probedAt: new Date(hit.at).toISOString(), cached: true });
    }
    const running = this.inFlight.get(key);
    if (running) return running;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProbeError(`the ${task.harness} skill discovery timed out after ${this.timeoutMs / 1000}s`, 504));
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
        this.entries.set(key, { result, at: at.getTime() });
        return { result, probedAt: at.toISOString(), cached: false };
      })
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
        controller.abort(); // a finished discovery never leaves its child alive
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, attempt);
    return attempt;
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
