import { resolve } from "node:path";

const removals = new Map<string, number>();

/** Block task creation across the async preflight window of project removal. */
export function beginProjectRemoval(path: string): () => void {
  const key = resolve(path);
  removals.set(key, (removals.get(key) ?? 0) + 1);
  return () => {
    const remaining = (removals.get(key) ?? 1) - 1;
    if (remaining === 0) removals.delete(key);
    else removals.set(key, remaining);
  };
}

export function isProjectRemovalInProgress(path: string): boolean {
  return removals.has(resolve(path));
}
