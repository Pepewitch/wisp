import { AsyncLocalStorage } from "node:async_hooks";

import { logFailure } from "./failure-log";

const current = new AsyncLocalStorage<HomeLifetime>();

/** Detached stateful work must settle before an in-process owner hands off. */
export class HomeLifetime {
  draining = false;
  private pending = new Set<Promise<unknown>>();

  run<T>(work: () => T): T { return current.run(this, work); }

  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    // A rejection still settles ownership; leave error handling to the caller.
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  async drain(): Promise<void> {
    this.draining = true;
    // A finishing launch/turn can enqueue more work before it settles.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export function trackHomeWork<T>(work: Promise<T>): Promise<T> {
  return current.getStore()?.track(work) ?? work;
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
export function backgroundPass(label: string, work: () => Promise<unknown>): Promise<void> {
  // async, so a synchronous throw from `work` becomes this pass's rejection too
  return trackHomeWork((async () => { await work(); })()).catch((error: unknown) => {
    logFailure(`${label} failed`, error);
  });
}

export function homeIsDraining(): boolean { return current.getStore()?.draining ?? false; }
