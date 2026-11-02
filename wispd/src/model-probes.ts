import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { discoverModels, MODEL_DISCOVERY, type AdapterDef, type ModelProbeSpawnFn } from "./adapters";
import type { SpawnResult } from "./doctor";
import { emit } from "./events";
import { trackHomeWork } from "./home-lifetime";
import { assertExecutableAllowed } from "./launch-policy";
import { DEFAULT_MAX_ERROR_BYTES, runBoundedCommand } from "./subprocess";
import { isRecord } from "./validate";

export const MODEL_PROBE_TIMEOUT_MS = 10_000;
export const MODEL_PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const MODEL_PROBE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How soon a refresh in which a discovering harness reported no models is
 * tried again. Such an answer is usually transient (a CLI briefly signed out,
 * offline, or slow under load), and waiting the full interval would leave the
 * harness unpickable for a day.
 */
export const MODEL_PROBE_RETRY_MS = 5 * 60 * 1000;
const MODEL_PROBE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/** Production async process runner; unlike bunSpawn it never blocks the event loop. */
export const bunModelProbeSpawn: ModelProbeSpawnFn = async (cmd, signal): Promise<SpawnResult> => {
  assertExecutableAllowed(cmd, "model discovery probe");
  return runBoundedCommand({
    cmd,
    signal,
    timeoutMs: MODEL_PROBE_TIMEOUT_MS,
    maxBytes: MODEL_PROBE_MAX_BYTES,
    maxErrorBytes: DEFAULT_MAX_ERROR_BYTES,
  }, "model discovery probe");
};

export interface CachedModels {
  list: string[];
  defaultModel: string | null;
  probedAt: string;
}

export interface ModelCacheEntry {
  models: CachedModels | null;
  modelsError?: string;
}

export interface ModelProbeCacheOptions {
  spawn?: ModelProbeSpawnFn;
  timeoutMs?: number;
  now?: () => Date;
  /** Omit for an in-memory cache. The daemon supplies its Wisp-home path. */
  cachePath?: string;
  refreshIntervalMs?: number;
}

const isMissingBinary = (message: string): boolean =>
  /ENOENT|no such file|not found on PATH|not found/i.test(message);

interface PersistedModelCache {
  version: 1;
  entries: Record<string, {
    adapterSignature: string;
    models: CachedModels;
  }>;
  /** When a refresh in which a discovering harness answered nothing is due again (MODEL_PROBE_RETRY_MS), so a restart keeps the date. */
  retryAt?: string;
}

function adapterSignature(def: AdapterDef): string {
  const discovery = def.modelDiscovery ? MODEL_DISCOVERY[def.modelDiscovery] : undefined;
  // Adapter fields are not the whole contract: changing a strategy's parser
  // can change its answer without changing the strategy name. Hash its source
  // so an upgrade cannot restore a semantically stale 24-hour catalog.
  const discoverySignature = discovery
    ? createHash("sha256").update(Function.prototype.toString.call(discovery)).digest("hex")
    : null;
  return JSON.stringify([def.bin, def.exec, def.model ?? null, def.modelDiscovery ?? null, discoverySignature]);
}

function validCachedModels(value: unknown): value is CachedModels {
  return isRecord(value)
    && Array.isArray(value.list)
    && value.list.length <= 10_000
    && value.list.every((model) => typeof model === "string")
    && (value.defaultModel === null || typeof value.defaultModel === "string")
    && typeof value.probedAt === "string"
    && Number.isFinite(Date.parse(value.probedAt));
}

function sameModelList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  // A harness CLI may emit the same catalog in a different order between runs;
  // that is not a change worth a client refetch.
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((model, i) => model === sortedRight[i]);
}

function sameAnswer(left: ModelCacheEntry, right: ModelCacheEntry): boolean {
  return left.modelsError === right.modelsError
    && left.models?.defaultModel === right.models?.defaultModel
    && sameModelList(left.models?.list ?? null, right.models?.list ?? null);
}

/**
 * The daemon-owned, last-successful-result cache. A refresh is coalesced while
 * one is in flight, callers receive the previous snapshot immediately, and a
 * failed refresh does not discard a usable model list.
 */
export class ModelProbeCache {
  private readonly entries = new Map<string, ModelCacheEntry>();
  private refreshInFlight: Promise<void> | null = null;
  private readonly spawn: ModelProbeSpawnFn;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly cachePath: string | undefined;
  private readonly refreshIntervalMs: number;
  private lastRefreshAttemptAt = 0;
  /** A failed discovery's earlier due time; null once a refresh had no such failure. */
  private retryAt: number | null = null;
  private readonly stopping = new AbortController();

  constructor(
    private readonly adapters: Record<string, AdapterDef>,
    options: ModelProbeCacheOptions = {},
  ) {
    this.spawn = options.spawn ?? bunModelProbeSpawn;
    this.timeoutMs = options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.cachePath = options.cachePath;
    this.refreshIntervalMs = options.refreshIntervalMs ?? MODEL_PROBE_REFRESH_INTERVAL_MS;
    for (const name of Object.keys(adapters)) this.entries.set(name, { models: null });
    this.load();
  }

  snapshot(name: string): ModelCacheEntry {
    return this.entries.get(name) ?? { models: null };
  }

  snapshotAll(): Record<string, ModelCacheEntry> {
    return Object.fromEntries(Object.entries(this.adapters).map(([name]) => [name, this.snapshot(name)]));
  }

  /** Refresh stale data in the background without repeatedly probing stable catalogs. */
  refreshIfStale(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const age = this.now().getTime() - this.lastRefreshAttemptAt;
    if (age >= 0 && age < this.refreshIntervalMs) {
      return Promise.resolve();
    }
    return this.refresh();
  }

  /**
   * Abandon the refresh in flight, killing its probes, and start no more. It
   * is a read-only cache refresh, so a stopping daemon must not wait up to a
   * probe timeout for it. The cache keeps what it had.
   */
  stop(): void {
    this.stopping.abort(new Error("the daemon is stopping"));
  }

  /** Force a refresh. Explicit re-probes use this even when the cache is fresh. */
  refresh(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const attemptAt = this.now().getTime();
    this.lastRefreshAttemptAt = attemptAt;
    let changed = false;
    let cacheUpdated = false;
    let discoveryFailed = false;
    this.refreshInFlight = Promise.all(
      Object.entries(this.adapters).map(async ([name, def]) => {
        const previous = this.snapshot(name);
        const next = await this.probe(def);
        // abandoned, not failed: an interrupted probe is no news about the harness
        if (this.stopping.signal.aborted) return;
        const answer = next.models ? next : { ...next, models: previous.models };
        this.entries.set(name, answer);
        if (!sameAnswer(previous, answer)) changed = true;
        if (def.modelDiscovery && next.models) cacheUpdated = true;
        // a missing binary stays missing until someone installs it: the daily pass finds it
        if (def.modelDiscovery && !next.models && next.modelsError !== "bin not found") discoveryFailed = true;
      }),
    )
      .then(async () => {
        // an abandoned refresh learned nothing: the retry it was meant to answer stays due
        if (this.stopping.signal.aborted) return;
        // the next refreshIfStale (a picker read, a restart) tries again soon, not in a day
        const hadRetry = this.retryAt !== null;
        this.retryAt = discoveryFailed ? attemptAt + Math.min(MODEL_PROBE_RETRY_MS, this.refreshIntervalMs) : null;
        if (this.retryAt !== null) this.lastRefreshAttemptAt = this.retryAt - this.refreshIntervalMs;
        // announced first: clients read the snapshot in memory, and a file write must not hold the news back
        if (changed) emit({ type: "harnesses" });
        if (cacheUpdated || discoveryFailed || hadRetry) await this.persist();
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return trackHomeWork(this.refreshInFlight);
  }

  private load(): void {
    if (!this.cachePath) return;
    try {
      if (!existsSync(this.cachePath) || statSync(this.cachePath).size > MODEL_PROBE_CACHE_MAX_BYTES) return;
      const parsed: unknown = JSON.parse(readFileSync(this.cachePath, "utf8"));
      if (!isRecord(parsed)) return;
      const store = parsed as Partial<PersistedModelCache>;
      if (store.version !== 1 || !isRecord(store.entries)) return;
      let complete = true;
      const probedTimes: number[] = [];
      for (const [name, def] of Object.entries(this.adapters)) {
        if (!def.modelDiscovery) continue;
        const cached = store.entries[name];
        if (
          !isRecord(cached)
          || cached.adapterSignature !== adapterSignature(def)
          || !validCachedModels(cached.models)
          // an empty list is no answer (older builds stored one): probe again at boot
          || cached.models.list.length === 0
        ) {
          complete = false;
          continue;
        }
        this.entries.set(name, { models: cached.models });
        probedTimes.push(Date.parse(cached.models.probedAt));
      }
      this.lastRefreshAttemptAt = complete && probedTimes.length > 0 ? Math.min(...probedTimes) : 0;
      const retryAt = typeof store.retryAt === "string" ? Date.parse(store.retryAt) : Number.NaN;
      if (Number.isFinite(retryAt)) {
        this.retryAt = retryAt;
        this.lastRefreshAttemptAt = Math.min(this.lastRefreshAttemptAt, retryAt - this.refreshIntervalMs);
      }
    } catch {
      // This file is only a cache. A partial or hand-edited file starts cold.
    }
  }

  // Async on purpose: a cache write must not block the event loop. load() above
  // stays synchronous because the constructor cannot await.
  private async persist(): Promise<void> {
    if (!this.cachePath) return;
    const entries: PersistedModelCache["entries"] = {};
    for (const [name, def] of Object.entries(this.adapters)) {
      const models = this.entries.get(name)?.models;
      if (!def.modelDiscovery || !models) continue;
      entries[name] = { adapterSignature: adapterSignature(def), models };
    }
    const store: PersistedModelCache = { version: 1, entries, ...(this.retryAt !== null ? { retryAt: new Date(this.retryAt).toISOString() } : {}) };
    const text = JSON.stringify(store, null, 2) + "\n";
    if (Buffer.byteLength(text) > MODEL_PROBE_CACHE_MAX_BYTES) return;
    const temporary = `${this.cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.cachePath);
    } catch {
      // Discovery remains usable in memory when persistence is unavailable.
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async probe(def: AdapterDef): Promise<ModelCacheEntry> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let onStop: (() => void) | null = null;
    // A timeout or a daemon stop both end the probe at once, and kill it.
    const abandoned = new Promise<never>((_, reject) => {
      const abandon = (error: Error): void => {
        reject(error);
        controller.abort(error);
      };
      timeout = setTimeout(() => abandon(new Error(`model probe timed out after ${this.timeoutMs / 1000}s`)), this.timeoutMs);
      onStop = () => abandon(new Error("model probe abandoned: the daemon is stopping"));
      if (this.stopping.signal.aborted) onStop();
      else this.stopping.signal.addEventListener("abort", onStop, { once: true });
    });
    try {
      const discovery = await Promise.race([discoverModels(def, this.spawn, controller.signal), abandoned]);
      // A discovering harness that names no model has not answered: its notes
      // say why. Cached as an empty list, it would hide every model it had for
      // a whole refresh interval.
      if (def.modelDiscovery && !discovery.models?.length) {
        return { models: null, modelsError: discovery.notes.join("; ") || "the model probe reported no models" };
      }
      return {
        models: {
          list: discovery.models ?? [],
          defaultModel: discovery.defaultModel,
          probedAt: this.now().toISOString(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { models: null, modelsError: isMissingBinary(message) ? "bin not found" : message };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (onStop !== null) this.stopping.signal.removeEventListener("abort", onStop);
    }
  }
}
