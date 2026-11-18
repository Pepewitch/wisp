/**
 * The one way the daemon runs git: async, bounded, and never waiting on a
 * terminal prompt. Split out of worktree.ts, which re-exports it for its
 * existing importers.
 */
import { READ_TIMEOUT_MS, runBounded } from "./subprocess";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  /** stdout hit its byte budget; only `fullDiff` has a use for knowing. */
  truncated: boolean;
}

/**
 * Async spawn, always (a prior audit): every caller of this module runs on the
 * daemon's only thread — diffStat on each polled GET /api/tasks/:id, push,
 * archive, task creation — and a 2-second `git worktree add` or a slow
 * `git status` on a big repo must not stall all tasks and the entire API.
 *
 * Bounded, always (a later review): the run carries a deadline and a byte
 * budget, because neither existed. A `git` that hangs on an unresponsive
 * filesystem or a credential prompt used to wait forever, and output was
 * buffered in full before any cap looked at its size — so a generated
 * lockfile diff cost tens of megabytes to serve a 512 KiB response. The
 * budget is enforced while reading now; see subprocess.ts.
 */
export async function git(args: string[], cwd: string, options: GitRunOptions = {}): Promise<GitResult> {
  const result = await runBounded({
    cmd: ["git", ...args],
    cwd,
    // Never wait on a terminal prompt. The deadline already stops a hung
    // one, but stopping it costs the full timeout and reports as "git timed
    // out" rather than the auth failure it is. Task creation fetches from
    // origin now, so this went from theoretical to the common case for
    // anyone whose remote wants a passphrase.
    //
    // GIT_TERMINAL_PROMPT only. Blanking GIT_ASKPASS/SSH_ASKPASS would also
    // apply to `git push` and the archive commit on this shared helper, and
    // an empty askpass is a DIFFERENT contract from an unset one — it would
    // break a user whose push authenticates through an askpass helper.
    env: { GIT_TERMINAL_PROMPT: "0" },
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
  });
  if (result.cleanupError) {
    throw new Error(`git ${args[0] ?? ""}: ${result.cleanupError}`);
  }
  if (result.timedOut) {
    throw new Error(`git ${args[0] ?? ""} timed out after ${Math.round((options.timeoutMs ?? READ_TIMEOUT_MS) / 1000)}s and was stopped`);
  }
  // A cap-truncated read is a SUCCESS with less data, not a failure. The child
  // is killed on purpose once the budget is reached, so it exits by signal
  // rather than 0 — and treating that as an error would turn the very case
  // these budgets exist for (a generated diff far past the pane's 512 KiB)
  // into `git diff failed` instead of the labelled truncated diff the old
  // buffer-then-slice code returned. A deadline or a caller's cancellation
  // stays a failure: there, we do not have the answer at all.
  const ok = result.exitCode === 0 || result.truncated;
  return { ok, out: result.out.trim(), err: result.err.trim(), truncated: result.truncated };
}

export interface GitRunOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/** Cap on the one stderr line a git failure is allowed to put in a message. */
const GIT_ERR_CAP = 160;

/**
 * The FIRST NON-EMPTY LINE of git's complaint, capped (D1 part 3).
 *
 * git answers `git diff <base>` outside a repository with a warning about
 * --no-index followed by its whole ~40-line usage text, and every one of those
 * lines used to reach the web UI's diff pane verbatim. The line is what names
 * the fault; the rest is a manpage. Capping here is what stops the NEXT unknown
 * git failure from looking like that one.
 */
function gitErrLine(r: GitResult): string {
  const line = (r.err || r.out)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return "";
  return line.length > GIT_ERR_CAP ? `${line.slice(0, GIT_ERR_CAP)}…` : line;
}

export function must(r: GitResult, what: string): string {
  if (!r.ok) {
    const line = gitErrLine(r);
    throw new Error(line === "" ? what : `${what}: ${line}`);
  }
  return r.out;
}
