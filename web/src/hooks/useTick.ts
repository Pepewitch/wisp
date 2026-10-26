import { useSyncExternalStore } from "react"

interface Clock {
  subscribe(onChange: () => void): () => void;
  now(): number;
}

/** One interval per period, alive only while something reads it. */
function clock(periodMs: number): Clock {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      if (timer === null) {
        // the first subscriber may arrive long after the last one left
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const fn of listeners) fn();
        }, periodMs);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    now: () => now,
  };
}

const seconds = clock(1000);
const minutes = clock(60_000);

/** Never subscribes, so an inactive caller costs nothing and starts no timer. */
const idle = (): (() => void) => () => {};

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
export function useTick(active: boolean): number {
  return useSyncExternalStore(active ? seconds.subscribe : idle, seconds.now);
}

/**
 * The same clock by the minute, for words that change by the minute ("4 min
 * ago"): a settled task's card has no reason to re-render every second.
 */
export function useMinuteTick(active: boolean): number {
  return useSyncExternalStore(active ? minutes.subscribe : idle, minutes.now);
}
