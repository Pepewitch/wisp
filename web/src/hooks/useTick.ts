import { useSyncExternalStore } from "react"

/**
 * A clock that re-renders its subscribers once a second.
 *
 * `useSyncExternalStore` rather than state-plus-an-effect because the wall
 * clock IS external mutable state: reading it during render is impure and
 * seeding it from an effect renders twice. The snapshot is a cached timestamp
 * that only changes on a tick, so React's Object.is comparison settles — a
 * getSnapshot returning Date.now() directly would loop forever.
 *
 * ONE interval serves every live timer on screen, exists only while something
 * is subscribed, and hands every reader the same instant.
 */
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    // the first subscriber may arrive long after the last one left
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const fn of listeners) fn();
    }, 1000);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Never subscribes, so an inactive caller costs nothing and starts no timer. */
const idle = (): (() => void) => () => {};

export function useTick(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, () => now);
}
