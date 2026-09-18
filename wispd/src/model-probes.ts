import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { discoverModels, type AdapterDef, type ModelProbeSpawnFn } from "./adapters";
import type { SpawnResult } from "./doctor";
import { emit } from "./events";
import { assertExecutableAllowed } from "./launch-policy";
import { DEFAULT_MAX_ERROR_BYTES, runBoundedCommand } from "./subprocess";

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.list)
    && record.list.length <= 10_000
    && record.list.every((model) => typeof model === "string")
    && (record.defaultModel === null || typeof record.defaultModel === "string")
    && typeof record.probedAt === "string"
    && Number.isFinite(Date.parse(record.probedAt));
}

function sameAnswer(left: ModelCacheEntry, right: ModelCacheEntry): boolean {
  return left.modelsError === right.modelsError
    && left.models?.defaultModel === right.models?.defaultModel
    && JSON.stringify(left.models?.list ?? null) === JSON.stringify(right.models?.list ?? null);
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
    if (this.now().getTime() - this.lastRefreshAttemptAt < this.refreshIntervalMs) {
      return Promise.resolve();
    }
    return this.refresh();
  }

  /** Force a refresh. Explicit re-probes use this even when the cache is fresh. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.lastRefreshAttemptAt = this.now().getTime();
    let changed = false;
    this.refreshInFlight = Promise.all(
      Object.entries(this.adapters).map(async ([name, def]) => {
        const previous = this.snapshot(name);
        const next = await this.probe(def);
        const answer = next.models ? next : { ...next, models: previous.models };
        this.entries.set(name, answer);
        if (!sameAnswer(previous, answer)) changed = true;
      }),
    )
      .then(() => {
        this.persist();
        if (changed) emit({ type: "harnesses" });
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  private load(): void {
    if (!this.cachePath) return;
    try {
      if (!existsSync(this.cachePath) || statSync(this.cachePath).size > MODEL_PROBE_CACHE_MAX_BYTES) return;
      const parsed: unknown = JSON.parse(readFileSync(this.cachePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const store = parsed as Partial<PersistedModelCache>;
      if (store.version !== 1 || !store.entries || typeof store.entries !== "object") return;
      let complete = true;
      for (const [name, def] of Object.entries(this.adapters)) {
        if (!def.modelDiscovery) continue;
        const cached = store.entries[name];
        if (
          !cached
          || typeof cached !== "object"
          || cached.adapterSignature !== adapterSignature(def)
          || !validCachedModels(cached.models)
        ) {
          complete = false;
          continue;
        }
        this.entries.set(name, { models: cached.models });
        this.lastRefreshAttemptAt = Math.max(this.lastRefreshAttemptAt, Date.parse(cached.models.probedAt));
      }
      if (!complete) this.lastRefreshAttemptAt = 0;
    } catch {
      // This file is only a cache. A partial or hand-edited file starts cold.
    }
  }

  private persist(): void {
    if (!this.cachePath) return;
    const entries: PersistedModelCache["entries"] = {};
    for (const [name, def] of Object.entries(this.adapters)) {
      const models = this.entries.get(name)?.models;
      if (!def.modelDiscovery || !models) continue;
      entries[name] = { adapterSignature: adapterSignature(def), models };
    }
    const temporary = `${this.cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.cachePath);
    } catch {
      // Discovery remains usable in memory when persistence is unavailable.
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
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
