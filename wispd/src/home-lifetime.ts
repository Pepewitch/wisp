import { AsyncLocalStorage } from "node:async_hooks";

import { logFailure } from "./failure-log";

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
export function backgroundPass(label: string, work: () => Promise<unknown>, options: HomeWorkOptions = {}): Promise<void> {
  // async, so a synchronous throw from `work` becomes this pass's rejection too
  return trackHomeWork((async () => { await work(); })(), options).catch((error: unknown) => {
    logFailure(`${label} failed`, error);
  });
}

export function homeIsDraining(): boolean { return current.getStore()?.draining ?? false; }
