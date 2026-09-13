import { discoverModels, type AdapterDef, type ModelProbeSpawnFn } from "./adapters";
import type { SpawnResult } from "./doctor";
import { assertExecutableAllowed } from "./launch-policy";
import { DEFAULT_MAX_ERROR_BYTES, runBoundedCommand } from "./subprocess";

export const MODEL_PROBE_TIMEOUT_MS = 10_000;
export const MODEL_PROBE_MAX_BYTES = 2 * 1024 * 1024;

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
}

const isMissingBinary = (message: string): boolean =>
  /ENOENT|no such file|not found on PATH|not found/i.test(message);

/**
 * The daemon-owned, last-result cache. A refresh is coalesced while one is in
 * flight, and callers receive the previous snapshot immediately.
 */
export class ModelProbeCache {
  private readonly entries = new Map<string, ModelCacheEntry>();
  private refreshInFlight: Promise<void> | null = null;
  private readonly spawn: ModelProbeSpawnFn;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly adapters: Record<string, AdapterDef>,
    options: ModelProbeCacheOptions = {},
  ) {
    this.spawn = options.spawn ?? bunModelProbeSpawn;
    this.timeoutMs = options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    for (const name of Object.keys(adapters)) this.entries.set(name, { models: null });
  }

  snapshot(name: string): ModelCacheEntry {
    return this.entries.get(name) ?? { models: null };
  }

  snapshotAll(): Record<string, ModelCacheEntry> {
    return Object.fromEntries(Object.entries(this.adapters).map(([name]) => [name, this.snapshot(name)]));
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = Promise.all(
      Object.entries(this.adapters).map(async ([name, def]) => {
        this.entries.set(name, await this.probe(def));
      }),
    )
      .then(() => undefined)
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
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
