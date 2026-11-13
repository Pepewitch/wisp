import { resolve } from "node:path";

/**
 * Who fetches a repo's base refs, and when the create path may skip it.
 *
 * Every worktree task used to wait on its own `git fetch origin` before it
 * could start: 0.65–0.9 s against a real remote with nothing new, longer with
 * new commits, and up to the 20 s deadline on a slow one. The composer now asks
 * for that fetch while the person is still typing (POST /api/projects/base-refs),
 * and this module is what lets the create that follows reuse it:
 *
 *   - one fetch per repo at a time. A second prefetch, or a create, JOINS the
 *     one in flight. Two `git fetch` runs in one repo also race for the same
 *     remote-tracking ref locks, so joining is about correctness as well as cost;
 *   - a prefetch that started recently is not repeated (PREFETCH_COOLDOWN_MS),
 *     so a composer opened and closed in a loop costs one fetch, not one each;
 *   - a create from the composer skips its own fetch after a SUCCESSFUL one
 *     that started within BASE_REFS_FRESH_MS. A failed or timed-out attempt
 *     never counts, and no other create skips at all (see `beforeCreate`);
 *   - a merge Wisp makes drops the repo's freshness (`invalidate`).
 *
 * The fetch itself is injected rather than imported: it is worktree.ts's
 * `fetchBaseRefs`, and worktree.ts is also this module's only caller.
 *
 * Module state, not per-daemon state: what is being coordinated is a git
 * repository on disk and its ref locks, which two daemons in one process (the
 * test suite's case) would share just the same.
 */

/**
 * How long after a prefetch STARTS another prefetch for the repo is a no-op,
 * whatever its outcome: a composer reopened in a loop costs one fetch. Below
 * the composer's own 20 s between asks while someone types (web's
 * PREFETCH_REWARM_MS) on purpose, so each of those asks starts a fetch and the
 * refs are still fresh when Start is pressed; above it, they would land in
 * the cooldown and the refresh would quietly stop.
 */
export const PREFETCH_COOLDOWN_MS = 15_000;

/**
 * How recent a successful fetch must be for a composer create to fork from it
 * without fetching again, measured from when that fetch STARTED, since that is
 * the moment its refs describe. Thirty seconds is conservative: only a commit
 * that lands on origin in the half minute before Start can be missed, and the
 * task still records the exact base it forked from. It is long enough to cover
 * the composer's 20 s between asks plus the fetch itself, which is what lets a
 * Start pressed mid-sentence skip the wait.
 */
export const BASE_REFS_FRESH_MS = 30_000;

/** One attempt at refreshing a repo's remote-tracking refs: true only when origin's refs are now on disk. */
export type FetchBaseRefs = (repo: string) => Promise<boolean>;

/** What a prefetch request did: began a fetch, joined the one running, or found one started too recently to repeat. */
export type PrefetchState = "started" | "joined" | "recent";

export interface BeforeCreateOptions {
  /**
   * May this create fork from a fetch that already finished? Only the
   * composer's: its person was just shown the project, and its prefetch is
   * what made that fetch. Off for everything else (`wisp new`, an agent's
   * subtask, autopilot, a workflow, a bare API call): an orchestrating task
   * merges a PR and starts the next subtask seconds later, and that subtask
   * must see the merge. Off by default, so a caller nobody thought about keeps
   * the old fetch-every-time behaviour.
   */
  reuseRecent?: boolean;
}

interface RepoFetch {
  inFlight: Promise<boolean> | null;
  /** the `epoch` the running attempt started in: a merge since makes it stale */
  inFlightEpoch: number;
  /** bumped by `invalidate`: what an attempt started before it fetched predates a merge */
  epoch: number;
  /** when the latest attempt began, whatever came of it: the prefetch cooldown */
  attemptedAt: number;
  /** when the latest SUCCESSFUL attempt of this epoch began: all a composer create trusts */
  freshAt: number | null;
}

export class BaseRefFetches {
  private readonly repos = new Map<string, RepoFetch>();

  constructor(
    private readonly fetchOnce: FetchBaseRefs,
    // monotonic: a wall clock moved back would make an old fetch look fresh
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Refresh `repo`'s base refs in the background. `settled` never rejects and
   * only tells a test when the work is done; the route does not wait for it.
   */
  prefetch(repo: string): { state: PrefetchState; settled: Promise<void> } {
    const key = resolve(repo);
    const current = this.repos.get(key);
    if (current?.inFlight) return { state: "joined", settled: current.inFlight.then(() => undefined) };
    if (current && this.now() - current.attemptedAt < PREFETCH_COOLDOWN_MS) {
      return { state: "recent", settled: Promise.resolve() };
    }
    return { state: "started", settled: this.start(key).then(() => undefined) };
  }

  /**
   * The create path's fetch. Awaits one already running rather than starting a
   * second; with `reuseRecent`, skips when a fetch succeeded within
   * BASE_REFS_FRESH_MS; otherwise fetches, exactly as every create did before
   * prefetching existed.
   *
   * Joining a running attempt is the whole fetch for this create, whatever it
   * answers: it is the attempt the create would otherwise have made a moment
   * later, and a failure falls through to the refs on disk just the same. The
   * one exception is an attempt that started before a merge Wisp made: it is
   * waited out (two fetches must not overlap) and then fetched past.
   */
  async beforeCreate(repo: string, options: BeforeCreateOptions = {}): Promise<void> {
    const key = resolve(repo);
    for (;;) {
      const current = this.repos.get(key);
      if (current?.inFlight) {
        const epoch = current.inFlightEpoch;
        await current.inFlight;
        if (epoch === current.epoch) return;
        continue;
      }
      if (options.reuseRecent === true && current?.freshAt != null && this.now() - current.freshAt < BASE_REFS_FRESH_MS) return;
      await this.start(key);
      return;
    }
  }

  /**
   * Origin has just moved under Wisp's own hand (a merge): nothing fetched
   * before now may stand in for a fetch, and the next prefetch must not be
   * held back by the cooldown either.
   */
  invalidate(repo: string): void {
    const current = this.repos.get(resolve(repo));
    if (!current) return;
    current.epoch += 1;
    current.freshAt = null;
    current.attemptedAt = Number.NEGATIVE_INFINITY;
  }

  private start(key: string): Promise<boolean> {
    const startedAt = this.now();
    const state = this.repos.get(key) ?? { inFlight: null, inFlightEpoch: 0, epoch: 0, attemptedAt: startedAt, freshAt: null };
    state.attemptedAt = startedAt;
    const epoch = state.epoch;
    // `fetchOnce` is best effort and should not throw; the catch is what keeps
    // a fire-and-forget prefetch from ever becoming an unhandled rejection
    // if it does, and a throw is a failure like any other: not fresh.
    const attempt = this.fetchOnce(key)
      .catch(() => false)
      .then((ok) => {
        // An earlier success stays trusted after a later failure: its refs
        // still describe origin as it was then, and the window still bounds it.
        // A success that began before a merge describes origin before it.
        if (ok && epoch === state.epoch) state.freshAt = startedAt;
        state.inFlight = null;
        return ok;
      });
    state.inFlight = attempt;
    state.inFlightEpoch = epoch;
    this.repos.set(key, state);
    return attempt;
  }
}
