/**
 * Read-only pull-request discovery for a task's ORIGINAL branch.
 *
 * A Git branch carries no pull-request metadata. The forge is authoritative,
 * so Wisp asks the provider through its authenticated CLI and normalizes the
 * answer before it reaches the UI. The public union stays provider-neutral;
 * this first implementation recognizes GitHub origins only.
 */
import type { ProbeSpawnFn } from "./adapters";
import {
  githubPullRequest,
  githubPullRequestBatch,
  githubRepository,
  unavailableBranches,
} from "./pull-request-github";
import { bunProbeSpawn } from "./probes";
import type { Task } from "./types";

export type PullRequestLifecycle = "draft" | "open" | "merged" | "closed";
export type PullRequestChecks = "none" | "pending" | "passed" | "failed" | "unknown";
export type PullRequestReview = "none" | "required" | "approved" | "changes-requested" | "unknown";
export type PullRequestMergeState =
  | "ready"
  | "unstable"
  | "blocked"
  | "behind"
  | "conflicting"
  | "unknown";

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  lifecycle: PullRequestLifecycle;
  checks: PullRequestChecks;
  review: PullRequestReview;
  mergeState: PullRequestMergeState;
  updatedAt: string;
}

export type PullRequestStatus =
  | { kind: "found"; provider: "github"; pullRequest: PullRequestInfo }
  | { kind: "none"; provider: "github" }
  | { kind: "unsupported"; provider: null }
  | { kind: "unavailable"; provider: "github" | null };

export interface PullRequestOverviewEntry {
  status: PullRequestStatus;
  /** Time of the provider answer being displayed, not the latest failed attempt. */
  checkedAt: string;
  /** The last provider refresh failed, so status is the last successful answer. */
  stale: boolean;
}

export interface PullRequestOverview {
  tasks: Record<string, PullRequestOverviewEntry>;
}

export const PULL_REQUEST_TIMEOUT_MS = 10_000;
/** Shorter than the UI's 30s interval, so each visible-task tick can be fresh. */
export const PULL_REQUEST_CACHE_TTL_MS = 25_000;
/** Shorter than the UI's 60s overview interval, so one provider refresh serves every tab. */
export const PULL_REQUEST_OVERVIEW_TTL_MS = 55_000;
export const PULL_REQUEST_OVERVIEW_BATCH_SIZE = 20;
export const PULL_REQUEST_OVERVIEW_CONCURRENCY = 3;
export const PULL_REQUEST_OVERVIEW_BACKOFF_MAX_MS = 15 * 60_000;
const PULL_REQUEST_OVERVIEW_BACKOFF_BASE_MS = 60_000;
const PULL_REQUEST_CACHE_MAX_ENTRIES = 100;

export interface PullRequestCacheOptions {
  run?: ProbeSpawnFn;
  timeoutMs?: number;
  ttlMs?: number;
  overviewTtlMs?: number;
  overviewBatchSize?: number;
  overviewBackoffBaseMs?: number;
  overviewBackoffMaxMs?: number;
  now?: () => Date;
}

interface CachedPullRequest {
  status: PullRequestStatus;
  at: number;
}

interface KnownPullRequest {
  status: Exclude<PullRequestStatus, { kind: "unavailable" }>;
  checkedAt: string;
}

interface OverviewRefresh {
  entries: Map<string, PullRequestOverviewEntry>;
  globalFailure: boolean;
  successfulRepositories: string[];
  failedRepositories: string[];
}

interface OverviewRepositoryGroup {
  cwd: string;
  branches: Map<string, Task[]>;
}

interface RepositoryOverviewRefresh {
  statuses: Map<string, PullRequestStatus>;
  failed: boolean;
}

/**
 * The selected task keeps its short per-task cache. The sidebar uses one
 * repository-batched overview with a longer cache and exponential failure
 * backoff. Successful answers are shared between both paths; if an overview
 * refresh fails, the last answer remains visible and is explicitly stale.
 * Nothing is persisted: the provider remains the source of truth.
 */
export class PullRequestCache {
  private readonly entries = new Map<string, CachedPullRequest>();
  private readonly known = new Map<string, KnownPullRequest>();
  private overviewEntries = new Map<string, PullRequestOverviewEntry>();
  private readonly inFlight = new Map<string, Promise<PullRequestStatus>>();
  private overviewInFlight: Promise<void> | null = null;
  private overviewNextRefreshAt = 0;
  private overviewGlobalFailures = 0;
  private readonly overviewRepositoryBackoff = new Map<
    string,
    { failures: number; nextRefreshAt: number }
  >();
  private readonly repositories = new Map<string, string | null>();
  private readonly repositoryInFlight = new Map<string, Promise<string | null>>();
  private readonly run: ProbeSpawnFn;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly overviewTtlMs: number;
  private readonly overviewBatchSize: number;
  private readonly overviewBackoffBaseMs: number;
  private readonly overviewBackoffMaxMs: number;
  private readonly now: () => Date;

  constructor(options: PullRequestCacheOptions = {}) {
    this.run = options.run ?? bunProbeSpawn;
    this.timeoutMs = options.timeoutMs ?? PULL_REQUEST_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? PULL_REQUEST_CACHE_TTL_MS;
    this.overviewTtlMs = options.overviewTtlMs ?? PULL_REQUEST_OVERVIEW_TTL_MS;
    this.overviewBatchSize = Math.max(
      1,
      Math.floor(options.overviewBatchSize ?? PULL_REQUEST_OVERVIEW_BATCH_SIZE),
    );
    this.overviewBackoffBaseMs = options.overviewBackoffBaseMs ?? PULL_REQUEST_OVERVIEW_BACKOFF_BASE_MS;
    this.overviewBackoffMaxMs = options.overviewBackoffMaxMs ?? PULL_REQUEST_OVERVIEW_BACKOFF_MAX_MS;
    this.now = options.now ?? (() => new Date());
  }

  status(task: Task): Promise<PullRequestStatus> {
    if (task.mode === "local" || !task.branch) {
      return Promise.resolve({ kind: "unsupported", provider: null });
    }
    const known = this.known.get(task.id)?.status;
    if (isTerminalPullRequest(known)) return Promise.resolve(known);
    if (this.overviewInFlight) {
      return this.overviewInFlight.then(() => {
        const overview = this.overviewEntries.get(task.id);
        return overview ? overview.status : this.status(task);
      });
    }
    const hit = this.entries.get(task.id);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) {
      this.entries.delete(task.id);
      this.entries.set(task.id, hit);
      return Promise.resolve(hit.status);
    }
    if (hit) this.entries.delete(task.id);
    const running = this.inFlight.get(task.id);
    if (running) return running;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<PullRequestStatus>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ kind: "unavailable", provider: null });
      }, this.timeoutMs);
    });
    let providerRepository: string | null = null;
    let queriedProvider = false;
    let usedBackoff = false;
    const lookup = this.repository(task, controller.signal)
      .then((repository): Promise<PullRequestStatus> => {
        if (!repository) return Promise.resolve({ kind: "unsupported", provider: null });
        providerRepository = repository;
        if (this.repositoryIsBackedOff(repository)) {
          usedBackoff = true;
          return Promise.resolve(
            this.known.get(task.id)?.status ?? {
              kind: "unavailable",
              provider: "github",
            },
          );
        }
        queriedProvider = true;
        return githubPullRequest(task, repository, this.run, controller.signal);
      })
      .catch((): PullRequestStatus => ({ kind: "unavailable", provider: null }));
    const job = Promise.race([lookup, expired])
      .then((status) => {
        const checked = this.now();
        // A known answer served during provider backoff is intentionally not
        // cached as fresh: the overview must retain its original checkedAt
        // and stale bit until GitHub answers again.
        if (!usedBackoff) {
          setBounded(this.entries, task.id, { status, at: checked.getTime() });
        }
        if (providerRepository && queriedProvider) {
          if (status.kind === "unavailable") {
            this.backOffRepository(providerRepository, checked.getTime());
          } else {
            this.overviewRepositoryBackoff.delete(providerRepository);
          }
        }
        if (status.kind === "unavailable") {
          const overview = this.overviewEntries.get(task.id);
          if (overview && overview.status.kind !== "unavailable") {
            this.overviewEntries.set(task.id, { ...overview, stale: true });
          }
        }
        if (status.kind !== "unavailable" && !usedBackoff) {
          this.remember(task.id, status, checked.toISOString());
        }
        return status;
      })
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
        controller.abort();
        this.inFlight.delete(task.id);
      });
    this.inFlight.set(task.id, job);
    return job;
  }

  async overview(tasks: Task[]): Promise<PullRequestOverview> {
    const live = tasks.filter((task) => !task.archived);
    const now = this.now().getTime();
    if (this.overviewInFlight) {
      await this.overviewInFlight;
      return this.overviewSnapshot(live);
    }
    if (now < this.overviewNextRefreshAt) return this.overviewSnapshot(live);

    const controller = new AbortController();
    const lookup = this.refreshOverview(live, controller.signal).catch(
      (): OverviewRefresh => ({
        entries: this.failedOverview(live, this.now().toISOString()),
        globalFailure: true,
        successfulRepositories: [],
        failedRepositories: [],
      }),
    );
    this.overviewInFlight = lookup
      .then((refresh) => {
        this.overviewEntries = refresh.entries;
        const completedAt = this.now().getTime();
        if (refresh.globalFailure) {
          this.overviewGlobalFailures += 1;
          const backoff = Math.min(
            this.overviewBackoffBaseMs * 2 ** (this.overviewGlobalFailures - 1),
            this.overviewBackoffMaxMs,
          );
          this.overviewNextRefreshAt = completedAt + backoff;
        } else {
          this.overviewGlobalFailures = 0;
          this.overviewNextRefreshAt = completedAt + this.overviewTtlMs;
          for (const repository of refresh.successfulRepositories) {
            this.overviewRepositoryBackoff.delete(repository);
          }
          for (const repository of refresh.failedRepositories) {
            this.backOffRepository(repository, completedAt);
          }
          for (const [taskId, entry] of refresh.entries) {
            if (entry.stale || entry.status.kind === "unavailable") continue;
            this.remember(taskId, entry.status, entry.checkedAt);
            const checkedAt = Date.parse(entry.checkedAt);
            setBounded(this.entries, taskId, {
              status: entry.status,
              at: Number.isNaN(checkedAt) ? completedAt : checkedAt,
            });
          }
        }
      })
      .finally(() => {
        controller.abort();
        this.overviewInFlight = null;
      });
    await this.overviewInFlight;
    return this.overviewSnapshot(live);
  }

  private async refreshOverview(tasks: Task[], signal: AbortSignal): Promise<OverviewRefresh> {
    const entries = new Map<string, PullRequestOverviewEntry>();
    const checkedAt = this.now().toISOString();
    const groups = new Map<string, OverviewRepositoryGroup>();

    await Promise.all(
      tasks.map(async (task) => {
        if (task.mode === "local" || !task.branch) {
          const status: PullRequestStatus = { kind: "unsupported", provider: null };
          entries.set(task.id, { status, checkedAt, stale: false });
          return;
        }
        const known = this.known.get(task.id);
        if (known && isTerminalPullRequest(known.status)) {
          entries.set(task.id, { ...known, stale: false });
          return;
        }
        const running = this.inFlight.get(task.id);
        if (running) await running;
        const cached = this.entries.get(task.id);
        if (
          cached &&
          this.now().getTime() - cached.at < this.ttlMs &&
          cached.status.kind !== "unavailable"
        ) {
          entries.set(task.id, {
            status: cached.status,
            checkedAt: new Date(cached.at).toISOString(),
            stale: false,
          });
          return;
        }
        const repository = await this.repository(task, signal);
        if (!repository) {
          const status: PullRequestStatus = { kind: "unsupported", provider: null };
          entries.set(task.id, { status, checkedAt, stale: false });
          return;
        }
        const group = groups.get(repository) ?? {
          cwd: task.repo_path,
          branches: new Map<string, Task[]>(),
        };
        const branchTasks = group.branches.get(task.branch) ?? [];
        branchTasks.push(task);
        group.branches.set(task.branch, branchTasks);
        groups.set(repository, group);
      }),
    );

    const successfulRepositories: string[] = [];
    const failedRepositories: string[] = [];
    await mapWithConcurrency(
      [...groups.entries()],
      PULL_REQUEST_OVERVIEW_CONCURRENCY,
      async ([repository, group]) => {
        if (this.repositoryIsBackedOff(repository)) {
          for (const tasksForBranch of group.branches.values()) {
            for (const task of tasksForBranch) {
              entries.set(
                task.id,
                this.staleOrUnavailable(
                  task.id,
                  { kind: "unavailable", provider: "github" },
                  checkedAt,
                ),
              );
            }
          }
          return;
        }

        const refresh = await this.refreshRepository(repository, group, signal);
        for (const [taskId, status] of refresh.statuses) {
          if (status.kind === "unavailable") {
            entries.set(
              taskId,
              this.staleOrUnavailable(taskId, status, checkedAt),
            );
          } else {
            entries.set(taskId, { status, checkedAt, stale: false });
          }
        }
        (refresh.failed ? failedRepositories : successfulRepositories).push(
          repository,
        );
      },
    );

    return {
      entries,
      globalFailure: false,
      successfulRepositories,
      failedRepositories,
    };
  }

  /**
   * One slow origin must not discard completed answers from other origins.
   * Each repository gets its own timeout; queued workers start that clock only
   * when they acquire one of the three concurrency slots.
   */
  private async refreshRepository(
    repository: string,
    group: OverviewRepositoryGroup,
    parentSignal: AbortSignal,
  ): Promise<RepositoryOverviewRefresh> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<RepositoryOverviewRefresh>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(unavailableRepository(group));
      }, this.timeoutMs);
    });
    const lookup = this.queryRepository(repository, group, controller.signal)
      .catch(() => unavailableRepository(group));
    try {
      return await Promise.race([lookup, expired]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      controller.abort();
      parentSignal.removeEventListener("abort", abort);
    }
  }

  private async queryRepository(
    repository: string,
    group: OverviewRepositoryGroup,
    signal: AbortSignal,
  ): Promise<RepositoryOverviewRefresh> {
    const statuses = new Map<string, PullRequestStatus>();
    let failed = false;
    for (const branches of chunks(
      [...group.branches.keys()],
      this.overviewBatchSize,
    )) {
      const branchStatuses = await githubPullRequestBatch(
        repository,
        branches,
        group.cwd,
        this.run,
        signal,
      ).catch(() => unavailableBranches(branches));
      for (const branch of branches) {
        const status = branchStatuses.get(branch) ?? {
          kind: "unavailable",
          provider: "github",
        } satisfies PullRequestStatus;
        if (status.kind === "unavailable") failed = true;
        for (const task of group.branches.get(branch) ?? []) {
          statuses.set(task.id, status);
        }
      }
    }
    return { statuses, failed };
  }

  private failedOverview(tasks: Task[], attemptedAt: string): Map<string, PullRequestOverviewEntry> {
    return new Map(
      tasks.map((task) => [
        task.id,
        this.staleOrUnavailable(
          task.id,
          { kind: "unavailable", provider: null },
          attemptedAt,
        ),
      ]),
    );
  }

  private staleOrUnavailable(
    taskId: string,
    unavailable: Extract<PullRequestStatus, { kind: "unavailable" }>,
    attemptedAt: string,
  ): PullRequestOverviewEntry {
    const known = this.known.get(taskId);
    return known
      ? { ...known, stale: true }
      : { status: unavailable, checkedAt: attemptedAt, stale: false };
  }

  private overviewSnapshot(tasks: Task[]): PullRequestOverview {
    const ids = new Set(tasks.map((task) => task.id));
    return {
      tasks: Object.fromEntries(
        [...this.overviewEntries].filter(([taskId]) => ids.has(taskId)),
      ),
    };
  }

  private remember(
    taskId: string,
    status: Exclude<PullRequestStatus, { kind: "unavailable" }>,
    checkedAt: string,
  ): void {
    const known = { status, checkedAt };
    setBounded(this.known, taskId, known);
    if (this.overviewEntries.has(taskId)) {
      this.overviewEntries.set(taskId, { ...known, stale: false });
    }
  }

  private repositoryIsBackedOff(repository: string): boolean {
    const retry = this.overviewRepositoryBackoff.get(repository);
    return retry !== undefined && this.now().getTime() < retry.nextRefreshAt;
  }

  private backOffRepository(repository: string, at: number): void {
    const failures =
      (this.overviewRepositoryBackoff.get(repository)?.failures ?? 0) + 1;
    const backoff = Math.min(
      this.overviewBackoffBaseMs * 2 ** (failures - 1),
      this.overviewBackoffMaxMs,
    );
    this.overviewRepositoryBackoff.set(repository, {
      failures,
      nextRefreshAt: at + backoff,
    });
  }

  private repository(task: Task, signal: AbortSignal): Promise<string | null> {
    const hit = this.repositories.get(task.repo_path);
    if (hit !== undefined || this.repositories.has(task.repo_path)) {
      return Promise.resolve(hit ?? null);
    }
    const running = this.repositoryInFlight.get(task.repo_path);
    if (running) return running;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, this.timeoutMs);
    });
    const lookup = Promise.resolve()
      .then(() =>
        this.run(["git", "remote", "get-url", "origin"], {
          cwd: task.repo_path,
          signal: controller.signal,
        }),
      )
      .catch(() => null);
    const job = Promise.race([lookup, expired])
      .then((origin) => {
        if (!origin || origin.exitCode !== 0) return null;
        const repository = githubRepository(origin.stdout);
        setBounded(this.repositories, task.repo_path, repository);
        return repository;
      })
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
        controller.abort();
        signal.removeEventListener("abort", abort);
        this.repositoryInFlight.delete(task.repo_path);
      });
    this.repositoryInFlight.set(task.repo_path, job);
    return job;
  }
}

function unavailableRepository(
  group: OverviewRepositoryGroup,
): RepositoryOverviewRefresh {
  return {
    statuses: new Map(
      [...group.branches.values()].flatMap((tasks) =>
        tasks.map((task) => [
          task.id,
          { kind: "unavailable", provider: "github" } as const,
        ]),
      ),
    ),
    failed: true,
  };
}

function isTerminalPullRequest(
  status: PullRequestStatus | undefined,
): status is Extract<PullRequestStatus, { kind: "found" }> {
  return status?.kind === "found" &&
    (status.pullRequest.lifecycle === "merged" ||
      status.pullRequest.lifecycle === "closed");
}

function chunks<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > PULL_REQUEST_CACHE_MAX_ENTRIES) {
    map.delete(map.keys().next().value!);
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < values.length) {
      const value = values[next];
      next += 1;
      if (value !== undefined) await worker(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, run),
  );
}
