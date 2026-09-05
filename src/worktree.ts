import { closeSync, openSync } from "node:fs";
import { copyFile, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { wispCommand } from "./command";
import { LOG_DIR, WORKTREE_ROOT, repoConfigFor, type WispConfig } from "./config";
import { pathExists } from "./fsutil";

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * Async spawn, always (a prior audit): every caller of this module runs on the
 * daemon's only thread — diffStat on each polled GET /api/tasks/:id, push,
 * archive, task creation — and a 2-second `git worktree add` or a slow
 * `git status` on a big repo must not stall all tasks and the entire API.
 * Stdout and stderr are drained concurrently with the exit wait: a child
 * that fills the pipe buffer while we only await exit would deadlock.
 */
async function git(args: string[], cwd: string): Promise<GitResult> {
  const p = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: exitCode === 0, out: out.trim(), err: err.trim() };
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

function must(r: GitResult, what: string): string {
  if (!r.ok) {
    const line = gitErrLine(r);
    throw new Error(line === "" ? what : `${what}: ${line}`);
  }
  return r.out;
}

/**
 * Whether a task's worktree is still something git will answer questions about.
 *
 * `kind` is not decoration: the two not-ok states have different recoveries.
 * `missing` has nothing left to save; `detached` is a directory full of the
 * user's files that git has forgotten.
 */
export interface WorktreeHealth {
  ok: boolean;
  kind: "ok" | "missing" | "detached";
  /** one muted-register sentence naming the fault and the way out; null when ok */
  reason: string | null;
}

/**
 * THE authority on "is this still a git worktree" (D1 / Q8). Every surface that
 * reads a worktree — the diff pane, the sidebar's git marks, the task detail,
 * archive — asks this first, so they can no longer disagree: before it existed,
 * `diffStat` swallowed a failed git into "" and reported a broken worktree as
 * perfectly clean while the diff pane rendered git's usage text in red.
 *
 * Two not-ok states, kept apart because the recovery differs: the directory is
 * gone (nothing to save), or the directory is full of files and git has
 * forgotten it (the user's bytes are still there).
 *
 * Deliberately cheap — one stat and at most one git call — because the read
 * sites call it on every poll.
 */
export async function worktreeHealth(worktree: string): Promise<WorktreeHealth> {
  if (!(await pathExists(worktree))) {
    return {
      ok: false,
      kind: "missing",
      reason: `The worktree directory is gone (${worktree}) — archive this task to clear the row.`,
    };
  }
  if (!(await git(["rev-parse", "--git-dir"], worktree)).ok) {
    return {
      ok: false,
      kind: "detached",
      reason: `Git no longer tracks this worktree (${worktree}) — archive this task to clear the row; the files stay on disk.`,
    };
  }
  return { ok: true, kind: "ok", reason: null };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "task"
  );
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  base_commit: string;
}

export async function createWorktree(repoPath: string, taskId: string, slug: string, cfg: WispConfig): Promise<WorktreeInfo> {
  const repo = resolve(repoPath);
  must(await git(["rev-parse", "--git-dir"], repo), `not a git repository: ${repo}`);
  const base_commit = must(await git(["rev-parse", "HEAD"], repo), `repo has no commits: ${repo}`);
  if ((await git(["submodule", "status"], repo)).out !== "") {
    throw new Error("repos with submodules are not supported yet (failing loudly rather than half-working)");
  }
  const branch = `wisp/${taskId}-${slug}`;
  const path = join(WORKTREE_ROOT, `${basename(repo)}-${taskId}`);
  // Prune stale admin entries first: a manually deleted worktree dir leaves one
  // behind, and `git worktree add` at that path then fails confusingly (a prior audit).
  await git(["worktree", "prune"], repo);
  // A concurrent git process can hold index.lock — retry with backoff before failing.
  // The backoff sleep is async too: sleepSync would freeze the whole daemon (M1).
  let r = await git(["worktree", "add", "-b", branch, path], repo);
  for (let attempt = 0; !r.ok && r.err.includes("index.lock") && attempt < 3; attempt++) {
    await Bun.sleep(500 * 2 ** attempt);
    r = await git(["worktree", "add", "-b", branch, path], repo);
  }
  must(r, "git worktree add failed");
  await copyIntoWorktree(repo, path, cfg);
  return { path, branch, base_commit };
}

/**
 * A `local` task's worktree info: the checkout itself, on whatever branch it
 * is already on. NOTHING is created here — that is the entire point — so this
 * only reads what the repo already is, and records the same three fields a
 * worktree task carries so every downstream reader (diff, status, push) works
 * unchanged. base_commit is HEAD at creation, which makes the diff pane show
 * exactly what the agent did rather than the branch's whole history.
 */
export async function localWorktree(repoPath: string): Promise<WorktreeInfo> {
  const repo = resolve(repoPath);
  must(await git(["rev-parse", "--git-dir"], repo), `not a git repository: ${repo}`);
  const base_commit = must(await git(["rev-parse", "HEAD"], repo), `repo has no commits: ${repo}`);
  const branch = must(await git(["rev-parse", "--abbrev-ref", "HEAD"], repo), "could not read the current branch");
  if (branch === "HEAD") throw new Error(`${repo} is in detached HEAD — check out a branch before running a local task`);
  return { path: repo, branch, base_commit };
}

/** Directories never worth walking for copy patterns, however the glob is written. */
const COPY_SCAN_SKIP = ["node_modules/", ".git/"];
/** Upper bound on files one create will copy — a stray "*" must not clone the repo. */
export const COPY_FILE_CAP = 500;

/**
 * Files a project wants carried into every new worktree: the .env problem.
 * Git does not track them, so a fresh worktree cannot run without them.
 *
 * A pattern containing no "/" matches at ANY depth — ".env*" also takes
 * "backend/.env" — which is what lets one line cover a monorepo, and matches
 * what people expect from the equivalent feature in other tools. A pattern
 * WITH a "/" is anchored at the repo root and used verbatim.
 *
 * Results are deduped, sorted, and capped; `truncated` says the cap bit so a
 * caller can tell the user rather than silently copying an arbitrary 500.
 */
export async function matchCopyFiles(
  repoPath: string,
  patterns: string[],
): Promise<{ files: string[]; truncated: boolean }> {
  const repo = resolve(repoPath);
  const found = new Set<string>();
  let truncated = false;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === "") continue;
    const glob = new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`);
    try {
      for await (const rel of glob.scan({ cwd: repo, dot: true, onlyFiles: true })) {
        const normalized = rel.split("\\").join("/");
        if (COPY_SCAN_SKIP.some((skip) => normalized.startsWith(skip) || normalized.includes(`/${skip}`))) continue;
        if (found.size >= COPY_FILE_CAP) {
          truncated = true;
          break;
        }
        found.add(normalized);
      }
    } catch {
      // an unparseable pattern costs that pattern, never the whole create
    }
  }
  return { files: [...found].sort(), truncated };
}

/**
 * The copy step of worktree creation. Unions the project's `copyFiles` globs
 * with the older `envAllowlist` exact-name list, which keeps working verbatim
 * for anyone already relying on it.
 */
async function copyIntoWorktree(repo: string, dest: string, cfg: WispConfig): Promise<void> {
  const legacy = cfg.envAllowlist?.[repo] ?? cfg.envAllowlist?.[basename(repo)] ?? [];
  const patterns = repoConfigFor(cfg, repo)?.copyFiles ?? [];
  const { files } = patterns.length > 0 ? await matchCopyFiles(repo, patterns) : { files: [] as string[] };
  for (const rel of new Set([...legacy, ...files])) {
    const src = join(repo, rel);
    if (!(await pathExists(src))) continue;
    const target = join(dest, rel);
    // a nested match ("backend/.env") needs its directory to exist first
    await mkdir(dirname(target), { recursive: true });
    await copyFile(src, target);
  }
}

interface ScriptOutcome {
  /** the exit code, or null when the child was killed by a signal */
  code: number | null;
  timedOut: boolean;
  escalated: boolean;
}

/**
 * One script: spawn, log to an fd, enforce the timeout, escalate past a trapped
 * SIGTERM. It reports the outcome and judges nothing — the two callers disagree
 * about what a nonzero exit MEANS (a failed setup must fail the task, a failed
 * teardown must not strand a worktree), and that is the only thing they
 * disagree about. Sharing the machinery is the point: the timeout was added so
 * "a hung script cannot wedge a task in 'creating'" (a prior audit), and a
 * hung teardown hook could wedge an archive exactly the same way.
 */
async function runScript(
  cmd: string[],
  what: string,
  taskId: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMinutes: number,
  logPath: string,
): Promise<ScriptOutcome> {
  // fd-direct log setup, once per script at spawn time — allowed to stay sync (M1)
  const fd = openSync(logPath, "a");
  try {
    const child = Bun.spawn({ cmd, cwd, stdout: fd, stderr: fd, stdin: "ignore", env: { ...process.env, ...env } });
    let timedOut = false;
    let escalated = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(
      () => {
        timedOut = true;
        console.error(`[wisp] task ${taskId}: ${what} exceeded ${timeoutMinutes} min, killing it`);
        child.kill();
        // M3: a script that traps SIGTERM must not wedge the task in 'creating'
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            escalated = true;
            console.error(`[wisp] task ${taskId}: ${what} survived SIGTERM, escalating to SIGKILL`);
            child.kill("SIGKILL");
          }
        }, 5000);
      },
      timeoutMinutes * 60_000,
    );
    const code = await child.exited;
    clearTimeout(timer);
    clearTimeout(killTimer);
    return { code, timedOut, escalated };
  } finally {
    closeSync(fd);
  }
}

/**
 * A setup step: runScript, and a loud throw on anything but a clean exit. A
 * half-set-up worktree must fail the task rather than hand an agent a repo
 * whose install did not finish.
 */
async function runScriptStep(
  cmd: string[],
  what: string,
  taskId: string,
  cwd: string,
  env: Record<string, string>,
  cfg: WispConfig,
): Promise<void> {
  const logPath = join(LOG_DIR, `${taskId}-setup.log`);
  const r = await runScript(cmd, what, taskId, cwd, env, cfg.setupTimeoutMinutes, logPath);
  if (r.timedOut) {
    throw new Error(
      `${what} timed out after ${cfg.setupTimeoutMinutes} min and was killed${r.escalated ? " (escalated to SIGKILL after SIGTERM was trapped)" : ""}, see ${logPath}`,
    );
  }
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}), see ${logPath}`);
}

/** Timeout for a teardown hook when the caller carries no config (tests, CLI paths). */
const TEARDOWN_TIMEOUT_MINUTES = 5;

/**
 * A teardown step: the same timeout and SIGKILL escalation as a setup step,
 * without its throw. Teardown hooks stay BEST EFFORT — a failing
 * `rm -rf node_modules` must not strand a worktree the user asked to archive —
 * so the outcome is logged and the removal carries on. What it must not do is
 * hang, which is what it did before this shared the setup machinery: both hooks
 * were a bare `await Bun.spawn({...}).exited`.
 */
async function runTeardownStep(
  cmd: string[],
  what: string,
  taskId: string,
  worktree: string,
  timeoutMinutes: number,
): Promise<void> {
  const logPath = join(LOG_DIR, `${taskId}-archive.log`);
  const r = await runScript(cmd, what, taskId, worktree, {}, timeoutMinutes, logPath);
  if (r.timedOut) {
    console.error(
      `[wisp] task ${taskId}: ${what} timed out after ${timeoutMinutes} min and was killed${r.escalated ? " (escalated to SIGKILL)" : ""} — archive continues, see ${logPath}`,
    );
  } else if (r.code !== 0) {
    console.warn(`[wisp] task ${taskId}: ${what} exited ${r.code} — archive continues, see ${logPath}`);
  }
}

/**
 * Worktree setup, in a fixed order: the repo's own .wisp/setup.sh first (the
 * team's, committed and shared), then the project's configured setupScript
 * (this machine's, edited in the web UI). Both run, because dropping either
 * would silently change behaviour for anyone already using it.
 *
 * Both throw loudly on nonzero exit or timeout: a half-set-up worktree must
 * fail the task, not hand an agent a repo whose install did not finish.
 *
 * NEVER called for a local task — see TaskMode.
 */
export async function runSetup(
  taskId: string,
  repoPath: string,
  worktree: string,
  env: Record<string, string>,
  cfg: WispConfig,
): Promise<void> {
  const script = join(worktree, ".wisp", "setup.sh");
  if (await pathExists(script)) {
    await runScriptStep(["bash", script], "setup script", taskId, worktree, env, cfg);
  }
  const configured = repoConfigFor(cfg, repoPath)?.setupScript?.trim();
  if (configured) {
    await runScriptStep(["bash", "-c", configured], "project setup script", taskId, worktree, env, cfg);
  }
}

/** Porcelain status lines (one per dirty/untracked path) — shared by isDirty and statusSummary. */
async function porcelainStatus(worktree: string): Promise<string[]> {
  const out = (await git(["status", "--porcelain"], worktree)).out;
  return out === "" ? [] : out.split("\n");
}

export async function isDirty(worktree: string): Promise<boolean> {
  return (await porcelainStatus(worktree)).length > 0;
}

/**
 * True when the task branch has commits beyond its base that nothing else
 * holds: no up-to-date upstream AND not reachable from any other local branch
 * or remote-tracking ref. A branch merged into main (or pushed under another
 * name) is saved work even with no upstream — archive must not refuse it.
 */
export async function hasUnpushedWork(worktree: string, branch: string, base_commit: string | null): Promise<boolean> {
  const head = (await git(["rev-parse", "HEAD"], worktree)).out;
  if (base_commit && head === base_commit) return false; // no new commits at all
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"], worktree);
  if (upstream.ok && (await git(["rev-list", "--count", "@{u}..HEAD"], worktree)).out === "0") return false;
  const others = (await git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], worktree)).out
    .split("\n")
    .filter((r) => r !== "" && r !== `refs/heads/${branch}`);
  if (others.length === 0) return true; // nothing else the commits could live on
  return (await git(["rev-list", "HEAD", "--not", ...others], worktree)).out !== "";
}

/**
 * Remote refs tried, in order, when the repo does not record `origin/HEAD`.
 * Never a bare local `main` — the point is the branch this work MERGES INTO,
 * and a stale local main would answer a different question.
 */
const UPSTREAM_FALLBACK_REFS = ["origin/main", "origin/master"];

/** The repo's default branch as a remote ref, or null if it cannot be named. */
async function upstreamRef(worktree: string): Promise<string | null> {
  const head = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], worktree);
  if (head.ok && head.out !== "" && head.out !== "origin/HEAD") return head.out;
  for (const ref of UPSTREAM_FALLBACK_REFS) {
    if ((await git(["rev-parse", "--verify", "--quiet", ref], worktree)).ok) return ref;
  }
  return null;
}

/**
 * What a task's changes are measured FROM — the same commit GitHub picks for
 * a pull request, which is not the commit the worktree was created at.
 *
 * The motivating case: an agent asked to review a PR runs `gh pr checkout`,
 * which moves the worktree's HEAD onto the PR's branch. That branch forks from
 * a main far NEWER than the worktree's base_commit, so `git diff base_commit`
 * reported every commit that landed on main in between — 726 files for a PR
 * that changed 21. GitHub compares against `merge-base(HEAD, main)`; this does
 * the same, so the pane shows what the branch actually did.
 *
 * The rule, in order:
 *   1. merge-base(HEAD, base_commit) — never diff across a fork, so a checkout
 *      that diverged from the task's base still reads as a diff, not a revert.
 *   2. merge-base(HEAD, <default branch>) — GitHub's base — but ONLY when it is
 *      strictly newer than (1). A task stacked on a feature branch has a
 *      merge-base with main way back at the fork, and using it would show the
 *      whole stack rather than this task's work; the ancestor check keeps (1).
 *
 * Every step degrades to the previous answer, so a repo with no remote, no
 * default branch, or an unrelated history behaves exactly as it did before.
 */
export async function resolveDiffBase(worktree: string, base_commit: string): Promise<string> {
  const forkPoint = await git(["merge-base", "HEAD", base_commit], worktree);
  const base = forkPoint.ok && forkPoint.out !== "" ? forkPoint.out : base_commit;
  const ref = await upstreamRef(worktree);
  if (!ref) return base;
  const upstream = await git(["merge-base", "HEAD", ref], worktree);
  if (!upstream.ok || upstream.out === "" || upstream.out === base) return base;
  // strictly newer only: `--is-ancestor` on equal commits is also true, which
  // the equality check above has already handled
  const newer = await git(["merge-base", "--is-ancestor", base, upstream.out], worktree);
  return newer.ok ? upstream.out : base;
}

export async function diffStat(worktree: string): Promise<string> {
  const staged = (await git(["diff", "--stat", "HEAD"], worktree)).out;
  const untracked = (await git(["ls-files", "--others", "--exclude-standard"], worktree)).out;
  const parts = [];
  if (staged) parts.push(staged);
  if (untracked) parts.push(`untracked: ${untracked.split("\n").length} file(s)`);
  return parts.join("\n") || "no changes";
}

/** Cap on the diff text served per request (512 KB) — a diff pane must never pull megabytes. */
const DIFF_CAP = 512 * 1024;

/**
 * A task's full diff for the web UI's diff pane. With a base commit, the diff
 * runs from resolveDiffBase() — GitHub's base, not the worktree's creation
 * commit — against the WORKING TREE, so committed branch work, staged and
 * unstaged changes are all included; without one, against HEAD. The base
 * actually used comes back in `base` so the pane can name it rather than
 * claiming one that was never diffed from.
 *
 * Untracked files are listed by name in `untracked` (gitignored paths stay
 * out — `ls-files --exclude-standard`) and their contents are appended as
 * new-file diffs so the Changes pane can show them on click. Diff text past
 * the cap is sliced and flagged truncated.
 */
export async function fullDiff(
  worktree: string,
  base_commit: string | null,
): Promise<{ diff: string; truncated: boolean; untracked: string[]; base: string | null }> {
  const base = base_commit === null ? null : await resolveDiffBase(worktree, base_commit);
  const [diffOut, lsOut] = await Promise.all([
    git(base ? ["diff", base] : ["diff", "HEAD"], worktree),
    git(["ls-files", "--others", "--exclude-standard"], worktree),
  ]);
  let diff = must(diffOut, "git diff failed");
  let truncated = diff.length > DIFF_CAP;
  if (truncated) diff = diff.slice(0, DIFF_CAP);
  const others = must(lsOut, "git ls-files failed");
  const untracked = others === "" ? [] : others.split("\n");
  if (!truncated) {
    const appended = await appendUntrackedDiffs(worktree, untracked, diff);
    diff = appended.diff;
    truncated = appended.truncated;
  }
  return { diff, truncated, untracked, base };
}

/** Remaining room under DIFF_CAP after `diff`, including the joining newline. */
function diffRoom(diff: string): number {
  return DIFF_CAP - (diff === "" ? 0 : diff.length + 1);
}

async function appendUntrackedDiffs(
  worktree: string,
  untracked: string[],
  diff: string,
): Promise<{ diff: string; truncated: boolean }> {
  let truncated = false;
  for (const path of untracked) {
    const room = diffRoom(diff);
    if (room <= 0) {
      truncated = true;
      break;
    }
    const patch = await untrackedPatch(worktree, path, room);
    if (patch === null) continue;
    const next = diff === "" ? patch : `${diff}\n${patch}`;
    if (next.length > DIFF_CAP) {
      return { diff: next.slice(0, DIFF_CAP), truncated: true };
    }
    diff = next;
  }
  return { diff, truncated };
}

/**
 * A synthetic `git diff --no-index /dev/null <path>` so parseDiff can render
 * an untracked file as a new-file diff without touching the index. Caps the
 * read at `room` bytes so a huge untracked file cannot blow the payload;
 * binary (NUL in the first 8 KB) is a marker, never bytes.
 */
async function untrackedPatch(worktree: string, relPath: string, room: number): Promise<string | null> {
  const abs = resolve(worktree, relPath);
  const root = resolve(worktree);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (abs !== root && !abs.startsWith(prefix)) return null;

  let fh;
  try {
    fh = await open(abs, "r");
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const probeLen = Math.min(8192, st.size);
    const probe = Buffer.alloc(probeLen);
    const { bytesRead: probed } = await fh.read(probe, 0, probeLen, 0);
    const head = probe.subarray(0, probed);
    if (head.includes(0)) return asNewFileDiff(relPath, head, true);

    const len = Math.min(Math.max(room, 0), st.size);
    if (len <= probed) return asNewFileDiff(relPath, Buffer.from(head.subarray(0, len)), false);
    const buf = Buffer.alloc(len);
    head.copy(buf);
    const { bytesRead } = await fh.read(buf, probed, len - probed, probed);
    return asNewFileDiff(relPath, buf.subarray(0, probed + bytesRead), false);
  } finally {
    await fh.close();
  }
}

function asNewFileDiff(path: string, body: Buffer, binary: boolean): string {
  const gitPath = `a/${path} b/${path}`;
  if (binary) {
    return [`diff --git ${gitPath}`, "new file mode 100644", `Binary files /dev/null and b/${path} differ`].join("\n");
  }
  const text = body.toString("utf8");
  if (text === "") {
    return [`diff --git ${gitPath}`, "new file mode 100644", "index 0000000..e69de29"].join("\n");
  }
  const missingNl = !text.endsWith("\n");
  const lines = (missingNl ? text : text.slice(0, -1)).split("\n");
  const header = lines.length === 1 ? "@@ -0,0 +1 @@" : `@@ -0,0 +1,${lines.length} @@`;
  const hunk = [header, ...lines.map((l) => `+${l}`)];
  if (missingNl) hunk.push("\\ No newline at end of file");
  return [`diff --git ${gitPath}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, ...hunk].join("\n");
}

/**
 * Sidebar git status for the web UI: dirty-file count (porcelain lines),
 * commits ahead of the base (0 when the task recorded none), and whether any
 * work is unpushed (hasUnpushedWork's reachability rules).
 *
 * `ahead` counts from resolveDiffBase(), the same base the diff pane measures
 * from — the two numbers describe one branch and disagreeing about where it
 * starts is how "21 files" ends up beside "103 commits".
 */
export async function statusSummary(
  worktree: string,
  branch: string,
  base_commit: string | null,
): Promise<{ dirtyFiles: number; ahead: number; unpushed: boolean }> {
  const base = base_commit === null ? null : await resolveDiffBase(worktree, base_commit);
  const [porcelain, ahead, unpushed] = await Promise.all([
    porcelainStatus(worktree),
    base
      ? git(["rev-list", "--count", `${base}..HEAD`], worktree).then((r) => Number(must(r, "git rev-list failed")))
      : Promise.resolve(0),
    hasUnpushedWork(worktree, branch, base_commit),
  ]);
  return { dirtyFiles: porcelain.length, ahead, unpushed };
}

export async function pushBranch(worktree: string, branch: string): Promise<string> {
  return must(await git(["push", "-u", "origin", branch], worktree), "git push failed");
}

/** What archive learned before it destroyed anything (Q11). */
export interface ArchivePreflight {
  health: WorktreeHealth;
  /** null = removal may proceed; a sentence = archive must refuse with it */
  refusal: string | null;
  /**
   * Set when removal will LEAVE the worktree directory on disk: one sentence
   * naming the path and why, for the response and the task's state_detail.
   */
  leftBehind: string | null;
}

/**
 * Everything about a worktree that can make archive say NO, and nothing that
 * destroys (Q11 / D4). It runs on the request path, before the 200, because a
 * refusal that lands after the bytes are gone is not a refusal.
 */
export async function archivePreflight(
  worktree: string,
  branch: string,
  base_commit: string | null,
  force: boolean,
): Promise<ArchivePreflight> {
  const health = await worktreeHealth(worktree);
  if (!health.ok) {
    // The health check HAS to come first: git cannot answer "is this dirty" or
    // "is this pushed" about a path it does not know, and asking anyway is not
    // harmless — hasUnpushedWork sees `for-each-ref` fail, finds no other refs
    // and returns TRUE, which caused the task to remain stuck behind a 409.
    //
    // The earlier design proposed "prune and continue, delete the directory
    // if it is still there": that holds for the admin entry and the task row,
    // NOT for the user's bytes. A directory full of files git never tracked,
    // with nothing stashed and nobody asked twice, is exactly the destruction
    // this product refuses — so plain archive leaves it and says where it is,
    // and force deletes it, which is what force is for. Recorded in the Q8
    // decision block.
    return {
      health,
      refusal: null,
      // nothing to leave behind when the directory is already gone
      leftBehind:
        health.kind === "detached" && !force
          ? `Git no longer tracks ${worktree}, so archive left the directory in place — the files are still there, and removing them is your call.`
          : null,
    };
  }
  const dirty = await isDirty(worktree);
  const unpushed = await hasUnpushedWork(worktree, branch, base_commit);
  if ((dirty || unpushed) && !force) {
    const reasons = [dirty && "uncommitted changes", unpushed && "unpushed commits"].filter(Boolean).join(" and ");
    const remedy = unpushed
      ? `push first (${wispCommand()} push), merge the branch into another branch (merged commits count as saved), or archive with force`
      : "archive with force";
    return { health, refusal: `worktree has ${reasons}; ${remedy}`, leftBehind: null };
  }
  return { health, refusal: null, leftBehind: null };
}

/** The commit that carries whatever was uncommitted when the task was archived. */
export const ARCHIVE_COMMIT_MESSAGE = "wisp: uncommitted work at archive";

/**
 * Uncommitted work becomes a COMMIT ON THE KEPT BRANCH (Q10 / D3), not a stash.
 * Worktrees share the parent repo's ref store, so every `git stash push` landed
 * in the user's real working repo, where nothing in wisp ever listed or popped
 * it and popping it by hand needed a checkout that no longer exists. The branch
 * always survives an archive, so a commit on it preserves exactly what the
 * stash preserved and puts it where a person will actually look for it.
 *
 * It must not be defeatable by the repo it runs in: --no-verify skips a
 * pre-commit hook and --no-gpg-sign skips a signing key that is not present,
 * because a hook or a missing key must not be able to fail the one step that
 * saves the user's bytes. An identity is supplied ONLY when git cannot resolve
 * one at all — overriding a configured user would misattribute their commit.
 */
async function commitDirtyWork(worktree: string, branch: string): Promise<void> {
  if (!(await isDirty(worktree))) return;
  must(await git(["add", "-A"], worktree), `could not stage uncommitted work on ${branch}`);
  // `git commit` exits nonzero on an empty commit, so the staged diff is the
  // guard rather than the exit code: nothing to commit must never fail archive
  if ((await git(["diff", "--cached", "--quiet"], worktree)).ok) return;
  const identity = (await git(["var", "GIT_AUTHOR_IDENT"], worktree)).ok
    ? []
    : ["-c", "user.name=wisp", "-c", "user.email=wisp@localhost"];
  must(
    await git([...identity, "commit", "--no-verify", "--no-gpg-sign", "-m", ARCHIVE_COMMIT_MESSAGE], worktree),
    `could not commit uncommitted work onto ${branch}`,
  );
}

/**
 * Archive's destructive half, run AFTER the response (Q11 / D4): the teardown
 * hooks and `git worktree remove --force` on a monorepo worktree are tens of
 * thousands of files and seconds of wall clock, and nothing in here can refuse
 * — `archivePreflight` already asked everything that could. It either finishes
 * or throws, and a throw is a background failure the caller must surface
 * (state_detail), never swallow.
 *
 * The branch is always kept.
 */
export async function removeWorktree(
  repoPath: string,
  worktree: string,
  branch: string,
  force: boolean,
  cfg?: WispConfig,
  taskId = "archive",
): Promise<void> {
  const repo = resolve(repoPath);
  const health = await worktreeHealth(worktree);
  if (!health.ok) {
    // The recovery (D1 part 2): a worktree git has forgotten used to 409
    // forever, because `git worktree remove` on a path git does not know fails.
    // Prune the stale admin entry and let the row clear. The bytes are the
    // deviation documented in archivePreflight — force takes them, plain
    // archive leaves them.
    await git(["worktree", "prune"], repo);
    if (force) await rm(worktree, { recursive: true, force: true });
    return;
  }
  await commitDirtyWork(worktree, branch);
  // Both hooks run before removal, the repo's own first and then the project's
  // configured one — the same order setup uses. Each is awaited so
  // `git worktree remove` never races it, and each is timeout-bounded.
  const minutes = cfg?.setupTimeoutMinutes ?? TEARDOWN_TIMEOUT_MINUTES;
  const cleanup = join(worktree, ".wisp", "cleanup.sh");
  if (await pathExists(cleanup)) {
    await runTeardownStep(["bash", cleanup], "cleanup script", taskId, worktree, minutes);
  }
  const configured = cfg && repoConfigFor(cfg, repo)?.archiveScript?.trim();
  if (configured) {
    await runTeardownStep(["bash", "-c", configured], "project archive script", taskId, worktree, minutes);
  }
  must(await git(["worktree", "remove", "--force", worktree], repo), "git worktree remove failed");
}
