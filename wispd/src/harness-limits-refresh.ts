/**
 * A finished turn is when a harness's plan usage has just moved, so it is the
 * moment to re-read that one harness's limits instead of waiting out the poll.
 * Only the turn's own harness is read; the others keep their cached answers.
 *
 * Keyed off the `turn` event rather than a task's `done` state: archive,
 * retention and process cleanup re-emit a task's unchanged state, and a turn
 * also ends as `failed` or `interrupted` after spending usage.
 */
import type { AdapterDef } from "./adapters";
import type { WispConfig } from "./config";
import { emit, subscribe, type WispEvent } from "./events";
import type { HarnessLimitsCache } from "./harness-limits";
import { turnForTask } from "./store";

/** The provider's own count can trail the turn's last event by a moment, and turns ending together share one read. */
export const TURN_END_SETTLE_MS = 5_000;
/** At most one turn-end read per harness in this span; a later turn's read is deferred, never dropped. */
export const TURN_END_MIN_GAP_MS = 30_000;
/** No client asked for limits in this long: nobody is looking, so a finished turn spawns nothing. */
export const LIMITS_WATCHED_MS = 10 * 60_000;

export interface LimitsTurnRefreshOptions {
  settleMs?: number;
  minGapMs?: number;
  watchedMs?: number;
  now?: () => number;
  /** the harness a turn ran on; the turn's own, since a task can switch agents between turns */
  harnessOfTurn?: (taskId: string, n: number) => string | null;
}

export class LimitsTurnRefresh {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastReadAt = new Map<string, number>();
  private readonly reads = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private readonly settleMs: number;
  private readonly minGapMs: number;
  private readonly watchedMs: number;
  private readonly now: () => number;
  private readonly harnessOfTurn: (taskId: string, n: number) => string | null;

  constructor(
    private readonly cache: HarnessLimitsCache,
    private readonly cfg: Pick<WispConfig, "factoryApiKey">,
    private readonly adapters: Record<string, AdapterDef>,
    options: LimitsTurnRefreshOptions = {},
  ) {
    this.settleMs = options.settleMs ?? TURN_END_SETTLE_MS;
    this.minGapMs = options.minGapMs ?? TURN_END_MIN_GAP_MS;
    this.watchedMs = options.watchedMs ?? LIMITS_WATCHED_MS;
    this.now = options.now ?? Date.now;
    this.harnessOfTurn = options.harnessOfTurn ?? ((taskId, n) => turnForTask(taskId, n)?.harness ?? null);
  }

  start(): void {
    this.unsubscribe = subscribe((event) => this.onEvent(event));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.reads);
  }

  private onEvent(event: WispEvent): void {
    if (this.stopped || event.type !== "turn" || event.status === "running") return;
    const harness = this.harnessOfTurn(event.taskId, event.n);
    const def = harness === null ? undefined : this.adapters[harness];
    if (harness === null || !def?.limits) return;
    if (this.timers.has(harness) || !this.cache.askedWithin(this.watchedMs)) return;
    const at = this.now();
    const last = this.lastReadAt.get(harness);
    const due = Math.max(at + this.settleMs, last === undefined ? 0 : last + this.minGapMs);
    const timer = setTimeout(() => {
      this.timers.delete(harness);
      this.read(harness, def);
    }, due - at);
    timer.unref?.();
    this.timers.set(harness, timer);
  }

  private read(harness: string, def: AdapterDef): void {
    if (this.stopped) return;
    this.lastReadAt.set(harness, this.now());
    const read = this.cache
      .readNow(harness, def, this.cfg)
      .then(() => {
        if (!this.stopped) emit({ type: "harness-limits", harness });
      })
      .finally(() => this.reads.delete(read));
    this.reads.add(read);
  }
}
