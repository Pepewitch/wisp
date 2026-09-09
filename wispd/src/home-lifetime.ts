import { AsyncLocalStorage } from "node:async_hooks";

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

export function homeIsDraining(): boolean { return current.getStore()?.draining ?? false; }
