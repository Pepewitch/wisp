/**
 * The daemon's plan-limits reads: production IO for the named strategies in
 * adapters/limits.ts, and the cache that lets every connected client poll
 * without each poll spawning a harness CLI.
 *
 * Limits are ACCOUNT state, not task state, so the cache is keyed by harness
 * (and, for droid, by which key it read with) rather than by task. Failures
 * are not cached: the next poll retries, and concurrent polls share one read.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  LIMIT_STRATEGIES,
  LimitsError,
  runLimits,
  type AdapterDef,
  type HarnessLimits,
  type LimitsIo,
  type LimitsStatus,
  type ProbeSpawnFn,
  type RpcFactory,
} from "./adapters";
import type { WispConfig } from "./config";
import { bunProbeSpawn, bunRpcFactory } from "./probes";

/**
 * Just under the web client's two-minute poll (HARNESS_LIMITS_POLL_MS). A TTL
 * equal to the poll would let every other poll land a moment before expiry and
 * stretch one open window's reads to four minutes; this keeps them at two, and
 * more clients never make them more frequent.
 */
export const LIMITS_TTL_MS = 110_000;
export const LIMITS_TIMEOUT_MS = 20_000;

export type FactoryKeySource = "settings" | "environment";

/**
 * The Factory API key for droid's limits: one saved in Settings wins, then
 * the daemon's environment. `FACTORY_API_KEY` is droid's own name for it;
 * `DROID_API_KEY` is accepted because that is what people export.
 */
export function factoryKey(
  cfg: Pick<WispConfig, "factoryApiKey">,
  env: Record<string, string | undefined> = process.env,
): { key: string; source: FactoryKeySource } | null {
  if (cfg.factoryApiKey) return { key: cfg.factoryApiKey, source: "settings" };
  const fromEnv = env.FACTORY_API_KEY || env.DROID_API_KEY;
  return fromEnv ? { key: fromEnv, source: "environment" } : null;
}

/** One harness's answer, as the route serves it. */
export interface HarnessLimitsEntry {
  name: string;
  status: LimitsStatus;
  limits: HarnessLimits | null;
  /** why there are no limits to show; null when status is ok */
  message: string | null;
  fetchedAt: string;
  cached: boolean;
}

export interface HarnessLimitsCacheOptions {
  spawnOnce?: ProbeSpawnFn;
  openRpc?: RpcFactory;
  fetch?: LimitsIo["fetch"];
  readFile?: (path: string) => string | null;
  homeDir?: string;
  scratchDir?: string;
  /** resolves a harness binary; null = not installed */
  which?: (bin: string) => string | null;
  env?: Record<string, string | undefined>;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Enough to tell two keys apart in a cache key, and nothing that could be turned back into one. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 16);
}

export class HarnessLimitsCache {
  private readonly entries = new Map<string, { key: string; at: number; value: HarnessLimitsEntry }>();
  private readonly inFlight = new Map<string, Promise<HarnessLimitsEntry>>();
  private readonly io: LimitsIo;
  private readonly which: (bin: string) => string | null;
  private readonly env: Record<string, string | undefined>;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private askedAt: number | null = null;

  constructor(options: HarnessLimitsCacheOptions = {}) {
    this.io = {
      spawnOnce: options.spawnOnce ?? bunProbeSpawn,
      openRpc: options.openRpc ?? bunRpcFactory,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      readFile: options.readFile ?? readTextFile,
      homeDir: options.homeDir ?? homedir(),
      scratchDir: options.scratchDir ?? tmpdir(),
    };
    this.which = options.which ?? ((bin) => Bun.which(bin));
    this.env = options.env ?? process.env;
    this.ttlMs = options.ttlMs ?? LIMITS_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? LIMITS_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Every harness that declares a limits read, in adapter order. */
  read(
    cfg: Pick<WispConfig, "factoryApiKey">,
    adapters: Record<string, AdapterDef>,
    options: { refresh?: boolean } = {},
  ): Promise<HarnessLimitsEntry[]> {
    this.askedAt = this.now().getTime();
    const declared = Object.entries(adapters).filter(([, def]) => def.limits);
    return Promise.all(declared.map(([name, def]) => this.one(name, def, cfg, options.refresh === true)));
  }

  /** Whether a client (the web poll, `wisp limits`) has asked for every harness's limits within `ms`. */
  askedWithin(ms: number): boolean {
    return this.askedAt !== null && this.now().getTime() - this.askedAt < ms;
  }

  /**
   * One harness, past the cache, leaving every other harness's reading alone:
   * what Settings' Test asks after a key is saved, and what a finished turn asks.
   */
  readNow(name: string, def: AdapterDef, cfg: Pick<WispConfig, "factoryApiKey">): Promise<HarnessLimitsEntry> {
    return this.one(name, def, cfg, true);
  }

  private one(
    name: string,
    def: AdapterDef,
    cfg: Pick<WispConfig, "factoryApiKey">,
    refresh: boolean,
  ): Promise<HarnessLimitsEntry> {
    const strategy = def.limits ? LIMIT_STRATEGIES[def.limits] : undefined;
    const credential = strategy?.credential === "factoryApiKey" ? (factoryKey(cfg, this.env)?.key ?? null) : null;
    // a changed key, binary or strategy is a different read, never a stale hit
    const key = `${name}\u0000${def.bin}\u0000${def.limits}\u0000${credential === null ? "-" : fingerprint(credential)}`;
    const at = this.now().getTime();
    const hit = this.entries.get(name);
    if (!refresh && hit && hit.key === key && at - hit.at < this.ttlMs) {
      return Promise.resolve({ ...hit.value, cached: true });
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const attempt = this.fetchOne(name, def, credential)
      .then((entry) => {
        if (entry.status === "ok") this.entries.set(name, { key, at: this.now().getTime(), value: entry });
        else if (hit?.key === key) this.entries.delete(name);
        return entry;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async fetchOne(name: string, def: AdapterDef, credential: string | null): Promise<HarnessLimitsEntry> {
    const entry = (status: LimitsStatus, limits: HarnessLimits | null, message: string | null): HarnessLimitsEntry => ({
      name,
      status,
      limits,
      message,
      fetchedAt: this.now().toISOString(),
      cached: false,
    });
    if (this.which(def.bin) === null) return entry("unavailable", null, `${name} is not installed on this machine`);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new LimitsError(`the ${name} limits read timed out after ${this.timeoutMs / 1000}s`);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    try {
      const limits = await Promise.race([
        runLimits(def, { now: this.now(), signal: controller.signal, credential }, this.io),
        timedOut,
      ]);
      return entry("ok", limits, null);
    } catch (error) {
      if (error instanceof LimitsError) return entry(error.status, null, error.message);
      return entry("error", null, error instanceof Error ? error.message : String(error));
    } finally {
      if (timer !== null) clearTimeout(timer);
      controller.abort(); // a finished read never leaves its child alive
    }
  }
}
