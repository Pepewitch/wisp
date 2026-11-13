import { useMemo, useSyncExternalStore } from "react"

interface Clock {
  subscribe(onChange: () => void): () => void;
  now(): number;
}

/** One interval per period, alive only while something reads it. */
export function clock(periodMs: number): Clock {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      // A reader may join up to a period after the last tick, and must not
      // read that tick's instant: the clock moves to now, and the readers it
      // already has move with it, so every reader still shares one instant.
      const joined = Date.now();
      if (joined !== now) {
        now = joined;
        for (const fn of listeners) fn();
      }
      listeners.add(onChange);
      if (timer === null) {
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

const MINUTE = 60_000;
const never = () => 0;
const HOUR = 60 * MINUTE;

/**
 * The first instant after `now` at which `fromNow(at)` can read differently.
 *
 * Every threshold in `lib/time.ts` falls on a whole minute of age ("just now"
 * ends at 60s, "1 min" at 120s), and from an hour on on a whole hour: "1h"
 * becomes "2h" at 120 min, "23h" becomes "1d" at 24h, and day and month
 * boundaries are whole hours of age too. So the next whole minute of age,
 * then the next whole hour, is never late, and never wakes a reading that
 * cannot have changed more than that often. An instant in the future (a
 * clock skewed against the daemon's) wakes on whole minutes until it is past.
 */
export function nextWordingChange(at: number, now: number): number {
  const age = now - at;
  if (age < 0) return now + (-age % MINUTE || MINUTE);
  const step = age < HOUR ? MINUTE : HOUR;
  return at + (Math.floor(age / step) + 1) * step;
}

/** A clock for one instant's relative wording: it ticks only when that wording can change. */
function wordingClock(at: number): Clock {
  let now = Date.now();
  return {
    subscribe(onChange) {
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        timer = setTimeout(() => {
          now = Date.now();
          onChange();
          arm();
        }, Math.max(0, nextWordingChange(at, Date.now()) - Date.now()));
      };
      // the same catch-up as `clock`: a reader joining late reads the present
      const joined = Date.now();
      if (joined !== now) {
        now = joined;
        onChange();
      }
      arm();
      return () => clearTimeout(timer);
    },
    now: () => now,
  };
}

/**
 * The present, for a relative reading of `at` ("5 min ago"), refreshed only
 * when that reading can change: once at a minute old, then each minute, then
 * each hour. A long transcript's bubbles used to share the one-second clock
 * and every one of them re-rendered every second for words that change once
 * a minute at most. `at` is epoch milliseconds; NaN never ticks.
 */
export function useWordingTick(at: number, active: boolean): number {
  const wording = useMemo(() => (Number.isFinite(at) ? wordingClock(at) : null), [at]);
  return useSyncExternalStore(active && wording ? wording.subscribe : idle, wording?.now ?? never);
}
