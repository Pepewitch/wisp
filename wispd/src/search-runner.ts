/**
 * Search, off the daemon's request thread.
 *
 * `searchTasks` is four full scans (store-search.ts), linear in history: at
 * tens of thousands of turns one search takes hundreds of milliseconds. On the
 * one JS thread that serves every request and stream, each keystroke in the
 * search box froze all of them for that long. So the scan runs in a Worker with
 * its own read-only connection to the same database; WAL lets it read while the
 * daemon writes. The answer is the same function over the same rows, so ranking,
 * caps and snippets are unchanged.
 *
 * One worker, one search at a time, the rest queued. A search whose client has
 * gone (the sidebar aborts the previous request when the query changes) is
 * dropped from the queue, or told to stop at its next scan if it is running. A
 * search that runs past its deadline is answered with an error and its worker
 * replaced, so one pathological query cannot wedge search for everyone after
 * it. A worker that dies is replaced on the next search.
 *
 * If a worker cannot be started at all, search runs in-process as it always did
 * (blocking, but answering) and says so once in the log, retrying the worker
 * after a pause.
 */
import { DB_PATH } from "./config";
import { db } from "./store-database";
import { searchTasks } from "./store-search";
import type { SearchResponse } from "./types";

export type SearchRequest =
  | { type: "open"; path: string }
  | { type: "search"; id: number; query: string; cancel: SharedArrayBuffer };

export type SearchWorkerReply =
  | { type: "ready" }
  | { type: "open-failed"; error: string }
  | { type: "result"; id: number; response: SearchResponse }
  | { type: "cancelled"; id: number }
  | { type: "failed"; id: number; error: string };

/** Far past any healthy scan; only a pathological query or a stuck disk reaches it. */
export const SEARCH_TIMEOUT_MS = 20_000;
/** Searches waiting behind the running one. Past this, answer "busy" rather than queue forever. */
export const SEARCH_QUEUE_LIMIT = 16;
const START_TIMEOUT_MS = 10_000;
const RETRY_WORKER_MS = 60_000;

/** A search that was not answered; `status` is the HTTP status to report it with. */
export class SearchUnavailable extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SearchUnavailable";
  }
}

interface Job {
  id: number;
  query: string;
  cancel: Int32Array;
  resolve(response: SearchResponse): void;
  reject(error: Error): void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The worker entry. A compiled binary embeds it as a second entry point
 * (build-binary.ts) and resolves it by the name it was built from; from source
 * it sits next to this file.
 */
function defaultEntry(): string {
  if (import.meta.url.includes("/$bunfs/")) return "./search-worker.ts";
  return new URL("./search-worker.ts", import.meta.url).href;
}

export interface SearchRunnerOptions {
  entry?: string;
  path?: string;
  timeoutMs?: number;
  /** The in-process answer when no worker can start. */
  fallback?: (query: string) => SearchResponse;
}

export class SearchRunner {
  private worker: Worker | null = null;
  private starting: Promise<Worker | null> | null = null;
  private workerUnavailableUntil = 0;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private nextId = 1;
  private readonly entry: string;
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly fallback: (query: string) => SearchResponse;

  constructor(options: SearchRunnerOptions = {}) {
    this.entry = options.entry ?? defaultEntry();
    this.path = options.path ?? DB_PATH;
    this.timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
    this.fallback = options.fallback ?? ((query) => searchTasks(query, db));
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResponse> {
    if (signal?.aborted) return Promise.reject(new SearchUnavailable("search cancelled", 503));
    if (this.queue.length >= SEARCH_QUEUE_LIMIT) {
      return Promise.reject(new SearchUnavailable("too many searches are waiting; try again in a moment", 503));
    }
    return new Promise<SearchResponse>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        query,
        cancel: new Int32Array(new SharedArrayBuffer(4)),
        resolve,
        reject,
        settled: false,
      };
      signal?.addEventListener("abort", () => this.abort(job), { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  /** Stop the worker and fail whatever is waiting; the next search starts a new one. */
  stop(): void {
    for (const job of this.queue.splice(0)) this.settle(job, new SearchUnavailable("search stopped", 503));
    if (this.active) this.settle(this.active, new SearchUnavailable("search stopped", 503));
    this.active = null;
    this.discardWorker();
  }

  private settle(job: Job, outcome: SearchResponse | Error): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
  }

  private abort(job: Job): void {
    const queued = this.queue.indexOf(job);
    if (queued !== -1) this.queue.splice(queued, 1);
    // A running scan stops at its next checkpoint; the worker stays ours until
    // it says so, so two scans never share it.
    else Atomics.store(job.cancel, 0, 1);
    this.settle(job, new SearchUnavailable("search cancelled", 503));
  }

  private pump(): void {
    if (this.active !== null) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.active = job;
    void this.ensureWorker().then((worker) => {
      if (this.active !== job) return;
      if (job.settled) return this.next();
      if (worker === null) {
        try {
          this.settle(job, this.fallback(job.query));
        } catch (error) {
          this.settle(job, error instanceof Error ? error : new Error(String(error)));
        }
        return this.next();
      }
      job.timer = setTimeout(() => this.expire(job), this.timeoutMs);
      const request: SearchRequest = { type: "search", id: job.id, query: job.query, cancel: job.cancel.buffer as SharedArrayBuffer };
      worker.postMessage(request);
    });
  }

  private next(): void {
    this.active = null;
    this.pump();
  }

  private expire(job: Job): void {
    if (this.active !== job) return;
    this.settle(job, new SearchUnavailable(
      `search took longer than ${this.timeoutMs / 1000} s and was stopped; try a longer or more specific phrase`,
      503,
    ));
    // The worker is still inside the scan and cannot be interrupted; retire it
    // so the searches behind this one do not wait for it.
    this.discardWorker();
    this.next();
  }

  private onReply(worker: Worker, reply: SearchWorkerReply): void {
    if (worker !== this.worker || reply.type === "ready" || reply.type === "open-failed") return;
    const job = this.active;
    if (job === null || job.id !== reply.id) return;
    if (reply.type === "result") this.settle(job, reply.response);
    else if (reply.type === "failed") this.settle(job, new Error(`search failed: ${reply.error}`));
    else this.settle(job, new SearchUnavailable("search cancelled", 503));
    this.next();
  }

  private onExit(worker: Worker, detail: string): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.starting = null;
    worker.terminate();
    console.error(`[wisp] search worker stopped: ${detail}`);
    if (this.active) {
      this.settle(this.active, new SearchUnavailable("search was interrupted; try again", 500));
      this.next();
    }
  }

  private discardWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    worker?.terminate();
  }

  private ensureWorker(): Promise<Worker | null> {
    if (this.starting) return this.starting;
    if (Date.now() < this.workerUnavailableUntil) return Promise.resolve(null);
    const starting = new Promise<Worker | null>((resolve) => {
      let worker: Worker | undefined;
      let started = false;
      const unavailable = (detail: string): void => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        // stop() already retired this worker: that is not a failure to start.
        const retired = worker !== undefined && this.worker !== worker;
        worker?.terminate();
        if (this.worker === worker) this.worker = null;
        if (this.starting === starting) this.starting = null;
        if (!retired) {
          this.workerUnavailableUntil = Date.now() + RETRY_WORKER_MS;
          console.error(`[wisp] search worker unavailable, searching in-process for now: ${detail}`);
        }
        resolve(null);
      };
      const timer = setTimeout(() => unavailable("it did not start in time"), START_TIMEOUT_MS);
      try {
        worker = new Worker(this.entry);
      } catch (error) {
        unavailable(error instanceof Error ? error.message : String(error));
        return;
      }
      const own = worker;
      // Owned from creation, so stop() can retire a worker that is still starting.
      this.worker = own;
      own.onmessage = (event: MessageEvent<SearchWorkerReply>) => {
        const reply = event.data;
        if (started) return this.onReply(own, reply);
        if (reply.type === "ready") {
          started = true;
          clearTimeout(timer);
          resolve(this.worker === own ? own : null);
        } else if (reply.type === "open-failed") {
          unavailable(reply.error);
        }
      };
      own.onerror = (event: ErrorEvent) => {
        if (started) this.onExit(own, event.message);
        else unavailable(event.message);
      };
      own.addEventListener("close", () => {
        if (started) this.onExit(own, "it exited");
        else unavailable("it exited while starting");
      });
      // Idle, it must not keep a CLI or test process alive; a search in flight
      // is held open by the request waiting on it.
      (own as Worker & { unref(): void }).unref();
      const open: SearchRequest = { type: "open", path: this.path };
      own.postMessage(open);
    });
    this.starting = starting;
    return starting;
  }
}

let runner: SearchRunner | null = null;

/** The daemon's search: same answer as `searchTasks`, without holding the request thread. */
export function runSearch(query: string, signal?: AbortSignal): Promise<SearchResponse> {
  runner ??= new SearchRunner();
  return runner.search(query, signal);
}

/** At shutdown, after requests have drained. */
export function stopSearch(): void {
  runner?.stop();
  runner = null;
}
