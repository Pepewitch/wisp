import { AsyncLocalStorage } from "node:async_hooks";

import { logFailure } from "./failure-log";
import { safeString } from "./text";

const current = new AsyncLocalStorage<HomeLifetime>();

/** Detached stateful work must settle before an in-process owner hands off. */
export class HomeLifetime {
  draining = false;
  private pending = new Set<Promise<unknown>>();
  /** Pending work that boot recovery takes over, so a process exit need not wait for it. */
  private recoverable = new Set<Promise<unknown>>();

  run<T>(work: () => T): T { return current.run(this, work); }

  track<T>(work: Promise<T>, options: HomeWorkOptions = {}): Promise<T> {
    this.pending.add(work);
    if (options.recoverable) this.recoverable.add(work);
    // A rejection still settles ownership; leave error handling to the caller.
    const settle = (): void => { this.pending.delete(work); this.recoverable.delete(work); };
    void work.then(settle, settle);
    return work;
  }

  /**
   * Wait for tracked work to settle. An in-process hand-off waits for all of
   * it. A process that is exiting (`exiting`) skips recoverable work: a turn
   * watcher, whose harness keeps running and is re-adopted at the next boot.
   */
  async drain(options: { exiting?: boolean } = {}): Promise<void> {
    this.draining = true;
    // A finishing launch/turn can enqueue more work before it settles.
    for (;;) {
      const waiting = [...this.pending].filter((work) => !(options.exiting && this.recoverable.has(work)));
      if (waiting.length === 0) return;
      await Promise.allSettled(waiting);
    }
  }
}

export interface HomeWorkOptions {
  /** Boot recovery resumes this work, so an exiting daemon does not wait for it. */
  recoverable?: boolean;
}

export function trackHomeWork<T>(work: Promise<T>, options: HomeWorkOptions = {}): Promise<T> {
  return current.getStore()?.track(work, options) ?? work;
}

/**
 * One pass of a background loop, or any detached chain, tracked as home work,
 * whose failure is logged (via logFailure, so a recurring one is summarized)
 * instead of vanishing. `track` marks a rejection as
 * handled for the lifetime's own bookkeeping, so a loop that only tracked its
 * pass lost every error without a trace (stuck detection and webhook delivery
 * both did), and one that did not track it would end the process on the
 * unhandled rejection. The loop runs again on its next tick either way.
 */
export function backgroundPass(label: string, work: () => Promise<unknown>, options: BackgroundPassOptions = {}): Promise<void> {
  // async, so a synchronous throw from `work` becomes this pass's rejection too
  return trackHomeWork((async () => { await work(); })(), options).then(
    () => { if (options.loop) recordLoopPass(label, null); },
    (error: unknown) => {
      if (options.loop) recordLoopPass(label, error);
      logFailure(`${label} failed`, error);
    },
  );
}

export interface BackgroundPassOptions extends HomeWorkOptions {
  /**
   * This is one pass of a named, recurring loop, whose outcome is kept for
   * the authenticated diagnostics (`wisp doctor` reads it). Per-task chains
   * leave it unset: they are not loops, and each would be a row of its own.
   */
  loop?: boolean;
}

/** How one background loop has been doing, since this process started. */
export interface LoopHealth {
  name: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The latest failure's message, kept after a success so a flapping loop still says why. */
  lastError: string | null;
  /** Failed passes since the last success; 0 while the loop is healthy. */
  consecutiveFailures: number;
}

const loops = new Map<string, LoopHealth>();

/** `error` is null for a pass that succeeded. */
export function recordLoopPass(name: string, error: unknown, now: Date = new Date()): void {
  const health = loops.get(name) ?? { name, lastSuccessAt: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0 };
  if (error === null) {
    health.lastSuccessAt = now.toISOString();
    health.consecutiveFailures = 0;
  } else {
    health.lastFailureAt = now.toISOString();
    health.lastError = (error instanceof Error ? error.message : safeString(error)).slice(0, 300);
    health.consecutiveFailures++;
  }
  loops.set(name, health);
}

/** Every loop that has finished a pass in this process, in the order each first did. */
export function loopHealth(): LoopHealth[] {
  return [...loops.values()].map((health) => ({ ...health }));
}

export function homeIsDraining(): boolean { return current.getStore()?.draining ?? false; }
