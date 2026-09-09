/**
 * One bounded way to run a short-lived command.
 *
 * Every git call in the daemon used to be `Bun.spawn` plus
 * `new Response(child.stdout).text()`: no deadline, and the whole output
 * buffered before anyone looked at its size. A review named both consequences.
 * The diff pane's 512 KiB cap was applied AFTER buffering, so a generated
 * lockfile diff could cost tens of megabytes of memory to serve a response
 * that admits to half a megabyte. And a `git` that hangs — a filesystem that
 * stopped answering, a credential prompt on a misconfigured remote — occupied
 * the daemon's only thread's attention indefinitely, with nothing to time out.
 *
 * So the budget is enforced while reading, not after, and every run carries a
 * deadline. Both limits are visible in the result rather than thrown, because
 * the callers differ on what they mean: a truncated diff is a normal answer the
 * pane labels, and a timed-out `git status` is a task-level error sentence.
 */
import { signalProcessTree } from "./process-tree";

/** A read probe should answer or get out of the way; a push may legitimately take longer. */
export const READ_TIMEOUT_MS = 20_000;
export const WRITE_TIMEOUT_MS = 120_000;

/**
 * How much of a stream is kept. Past this the reader stops storing bytes and
 * kills the child: a producer that keeps writing is answering a question
 * nobody can use, and the memory is the whole point of the limit.
 */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Just enough of a failure to name it; `gitErrLine` caps it again for display. */
export const DEFAULT_MAX_ERROR_BYTES = 64 * 1024;

/** Grace between the deadline's TERM and its KILL. */
const KILL_GRACE_MS = 2_000;

export interface RunOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Byte budget for stdout; reading stops and the child is killed past it. */
  maxBytes?: number;
  maxErrorBytes?: number;
  timeoutMs?: number;
  /** Caller-owned cancellation, on top of the deadline. */
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  out: string;
  err: string;
  /** stdout hit its budget: `out` is a prefix, and the child was stopped. */
  truncated: boolean;
  /** the deadline (or the caller's signal) ended it, not the command */
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * Read a stream up to `maxBytes`, then stop.
 *
 * Returning early is the point: the reader releases the lock and the caller
 * kills the child, so a command that keeps producing cannot keep the daemon
 * allocating. Chunks are decoded incrementally so a multi-byte character split
 * across a chunk boundary is not mangled.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | undefined,
  maxBytes: number,
  onCap: (() => void) | null,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) return { text: text + decoder.decode(), truncated };
      if (truncated) continue; // draining: read and discard so the child never blocks
      const room = maxBytes - bytes;
      if (value.byteLength >= room) {
        text += decoder.decode(value.subarray(0, room)) + decoder.decode();
        truncated = true;
        if (onCap) {
          // stdout: nothing beyond the budget can be used, so stop the child
          // from HERE — not after both readers resolve. The other stream only
          // reaches EOF when the process dies, so waiting would sit out the
          // whole deadline on a producer that already exceeded its budget
          // (measured: 19s instead of 200ms).
          onCap();
          return { text, truncated };
        }
        // stderr: keep draining. A hook or credential helper that writes more
        // than the budget to stderr is noisy, not failing, and killing an
        // otherwise-succeeding `git worktree add` or `push` over it would turn
        // chatter into a failed task (a review's note).
        continue;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A killed child's pipe reads as an error; whatever arrived is the answer.
    return { text: text + decoder.decode(), truncated };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a command with a byte budget and a deadline.
 *
 * stdout and stderr are drained CONCURRENTLY with the exit wait, because a
 * child that fills a pipe while the parent only awaits exit deadlocks — the
 * bug this preserves from the code it replaces.
 */
export async function runBounded(options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const child = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    // Its own group, so a deadline reaches whatever the command started —
    // `git` shelling out to a credential helper, a hook running a build.
    detached: true,
  });

  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessTree(child.pid, "SIGTERM", (signal) => child.kill(signal));
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signalProcessTree(child.pid, "SIGKILL", (signal) => child.kill(signal));
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  deadline.unref?.();
  const onAbort = (): void => {
    cancelled = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr] = await Promise.all([
      readCapped(child.stdout as ReadableStream<Uint8Array> | undefined, maxBytes, stop),
      // stderr keeps its budget but does NOT stop the child. A hook or a
      // credential helper that writes more than the budget to stderr is noisy,
      // not failing, and killing a `git worktree add` or a `push` over it would
      // turn chatter into a failed task (a review's note). Past the budget the
      // extra bytes are simply dropped: the reader stops storing, the child
      // keeps writing into a pipe nobody reads, and the deadline still bounds
      // the whole run.
      readCapped(
        child.stderr as ReadableStream<Uint8Array> | undefined,
        options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES,
        null,
      ),
    ]);
    const exitCode = await child.exited;
    return {
      exitCode,
      out: stdout.text,
      err: stderr.text,
      truncated: stdout.truncated,
      timedOut,
      cancelled,
    };
  } finally {
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * A concurrency gate.
 *
 * `/api/status` fans out one `worktreeHealth` plus one `statusSummary` across
 * EVERY live task, and each of those is several git processes. Twenty tasks and
 * a repeated poll is a process storm on one developer machine, so the fan-out
 * is bounded rather than trusted to stay small.
 */
export class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.available === 0) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.available -= 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter rather than returning it to
      // the pool and racing whoever asks first.
      if (next) next();
      else this.available += 1;
    }
  }
}

/**
 * Collapse overlapping identical work.
 *
 * Two clients polling `/api/status`, or one client whose SSE invalidation
 * arrives while its previous request is still running, ask the same question
 * twice. The second caller joins the answer already being computed instead of
 * starting a second fan-out.
 */
export class Coalescer<T> {
  private inFlight: Promise<T> | null = null;

  run(work: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight;
    const pending = work().finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }
}
