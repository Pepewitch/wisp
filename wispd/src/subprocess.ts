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
import { CommandGroup } from "./command-group";
import { CappedOutput } from "./capped-output";

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
/** Final bound on signalling, exit notification, and pipe cleanup after Stop. */
const STOP_BUDGET_MS = KILL_GRACE_MS + 1_000;

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
  /** An incomplete Stop must never masquerade as successful command cleanup. */
  cleanupError?: string;
}

/**
 * Bound the complete command: leader, inherited pipes, and termination.
 * Ordinary completion still drains both streams and preserves the exit code.
 */
export async function runBounded(options: RunOptions): Promise<RunResult> {
  if (options.signal?.aborted) {
    return { exitCode: null, out: "", err: "", truncated: false, timedOut: false, cancelled: true };
  }
  const child = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    detached: true,
  });
  const group = new CommandGroup(child);
  const stopped = Promise.withResolvers<void>();
  let stopping = false;
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let cleanupError: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;

  const finishStop = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (error) cleanupError = `command cleanup incomplete: ${error instanceof Error ? error.message : String(error)}`;
    group.close();
    stdout.close();
    stderr.close();
    // Even an unkillable leader must not hold a CLI caller's event loop open.
    if (child.exitCode === null && child.signalCode === null) child.unref();
    stopped.resolve();
  };
  const stop = (reason: "timeout" | "cancel" | "cap"): void => {
    if (stopping || settled) return;
    stopping = true;
    timedOut = reason === "timeout";
    cancelled = reason === "cancel";
    // The first stop reason owns the operation. A later timeout or abort must
    // neither restart the grace period nor schedule another escalation.
    clearTimeout(deadline);
    killTimer = setTimeout(() => {
      void group.inspect("SIGKILL").then(ended => {
        if (ended) finishStop();
      }, finishStop);
    }, KILL_GRACE_MS);
    hardTimer = setTimeout(() => {
      finishStop(new Error("process termination could not be confirmed before the cleanup deadline"));
    }, STOP_BUDGET_MS);
    void (async () => {
      if (await group.inspect("SIGTERM")) { finishStop(); return; }
      while (!settled) {
        await Bun.sleep(50);
        if (settled) return;
        if (await group.inspect()) { finishStop(); return; }
      }
    })().catch(finishStop);
  };
  const deadline = setTimeout(() => stop("timeout"), options.timeoutMs ?? READ_TIMEOUT_MS);
  const onAbort = (): void => stop("cancel");
  const stdout = new CappedOutput(child.stdout, options.maxBytes ?? DEFAULT_MAX_BYTES, () => stop("cap"));
  const stderr = new CappedOutput(child.stderr, options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const exited = child.exited.then(exitCode => {
    if (!settled && (stopping || !stdout.ended || !stderr.ended)) {
      // Capture only at the owned exit boundary. Later timeouts must validate
      // a surviving identity, not trust a historical numeric group ID.
      void group.captureExit().catch(() => {});
    }
    return exitCode;
  });
  try {
    await Promise.race([Promise.all([exited, stdout.done, stderr.done]), stopped.promise]);
    // EOF and a finalized leader do not settle a Stop: a resistant child may
    // have redirected both pipes and still be running in the command's group.
    if (stopping) await stopped.promise;
    return {
      exitCode: child.exitCode,
      out: stdout.text,
      err: stderr.text,
      truncated: stdout.truncated,
      timedOut,
      cancelled,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } finally {
    settled = true;
    group.close();
    clearTimeout(deadline);
    if (killTimer) clearTimeout(killTimer);
    if (hardTimer) clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", onAbort);
    stdout.close();
    stderr.close();
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
