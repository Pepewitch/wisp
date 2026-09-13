export const TASK_CACHE_MAX_ENTRIES = 64;
export const TASK_CACHE_SWEEP_WRITES = 16;

interface TaskCacheEntry<Value> {
  taskId: string;
  value: Value;
  at: number;
}

/**
 * Shared storage for short-lived per-task probe results.
 *
 * Reads remove their own expired entry, periodic write sweeps collect expired
 * entries that are never read again, and insertion order supplies a final
 * bound when every entry is still fresh.
 */
export class TaskCacheEntries<Value> {
  private readonly entries = new Map<string, TaskCacheEntry<Value>>();
  private writesUntilSweep = TASK_CACHE_SWEEP_WRITES;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = TASK_CACHE_MAX_ENTRIES,
    private readonly sweepWrites = TASK_CACHE_SWEEP_WRITES,
  ) {
    this.writesUntilSweep = sweepWrites;
  }

  get(key: string, now: number): { value: Value; at: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value, at: entry.at };
  }

  set(taskId: string, key: string, value: Value, at: number): void {
    this.entries.delete(key);
    this.entries.set(key, { taskId, value, at });
    this.writesUntilSweep -= 1;
    if (this.writesUntilSweep === 0) {
      this.sweep(at);
      this.writesUntilSweep = this.sweepWrites;
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  deleteTask(taskId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.taskId === taskId) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export interface TaskCache {
  deleteTask(taskId: string): void;
}

export function deleteTaskFromCaches(taskId: string, caches: readonly TaskCache[]): void {
  for (const cache of caches) cache.deleteTask(taskId);
}
