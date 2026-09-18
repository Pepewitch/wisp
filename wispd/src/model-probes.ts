import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { discoverModels, type AdapterDef, type ModelProbeSpawnFn } from "./adapters";
import type { SpawnResult } from "./doctor";
import { emit } from "./events";
import { trackHomeWork } from "./home-lifetime";
import { assertExecutableAllowed } from "./launch-policy";
import { DEFAULT_MAX_ERROR_BYTES, runBoundedCommand } from "./subprocess";
import { isRecord } from "./validate";

export const MODEL_PROBE_TIMEOUT_MS = 10_000;
export const MODEL_PROBE_MAX_BYTES = 2 * 1024 * 1024;
export const MODEL_PROBE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
}

function adapterSignature(def: AdapterDef): string {
  return JSON.stringify([def.bin, def.exec, def.model ?? null, def.modelDiscovery ?? null]);
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

  /** Force a refresh. Explicit re-probes use this even when the cache is fresh. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.lastRefreshAttemptAt = this.now().getTime();
    let changed = false;
    let cacheUpdated = false;
    this.refreshInFlight = Promise.all(
      Object.entries(this.adapters).map(async ([name, def]) => {
        const previous = this.snapshot(name);
        const next = await this.probe(def);
        const answer = next.models ? next : { ...next, models: previous.models };
        this.entries.set(name, answer);
        if (!sameAnswer(previous, answer)) changed = true;
        if (def.modelDiscovery && next.models) cacheUpdated = true;
      }),
    )
      .then(async () => {
        if (cacheUpdated) await this.persist();
        if (changed) emit({ type: "harnesses" });
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
        ) {
          complete = false;
          continue;
        }
        this.entries.set(name, { models: cached.models });
        probedTimes.push(Date.parse(cached.models.probedAt));
      }
      this.lastRefreshAttemptAt = complete && probedTimes.length > 0 ? Math.min(...probedTimes) : 0;
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
    const text = JSON.stringify({ version: 1, entries }, null, 2) + "\n";
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
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`model probe timed out after ${this.timeoutMs / 1000}s`);
        reject(error);
        controller.abort(error);
      }, this.timeoutMs);
    });
    try {
      const discovery = await Promise.race([discoverModels(def, this.spawn, controller.signal), timedOut]);
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
    }
  }
}
