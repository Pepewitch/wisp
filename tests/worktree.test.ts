import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WispConfig } from "../src/config";
import {
  ARCHIVE_COMMIT_MESSAGE,
  archivePreflight,
  createWorktree,
  fullDiff,
  hasUnpushedWork,
  isDirty,
  localWorktree,
  matchCopyFiles,
  removeWorktree,
  resolveDiffBase,
  runSetup,
  slugify,
  statusSummary,
  worktreeHealth,
} from "../src/worktree";

const cfg = { envAllowlist: {}, setupTimeoutMinutes: 5 } as WispConfig;

// test-local shell helper: sync is fine here (tests are not the daemon's thread)
function sh(cmd: string[], cwd: string): void {
  const p = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
}

/** sh() asserts the exit code and discards stdout; this one keeps it. */
function shOut(cmd: string[], cwd: string): string {
  return Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wisp-wt-"));
  sh(["git", "init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  sh(["git", "add", "."], repo);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  return repo;
}

describe("slugify", () => {
  test("normalizes and caps length", () => {
    expect(slugify("Fix the THING!! now")).toBe("fix-the-thing-now");
    expect(slugify("###")).toBe("task");
    expect(slugify("x".repeat(50)).length).toBeLessThanOrEqual(24);
  });
});

describe("worktree lifecycle", () => {
  test("create → isolated branch and path; allowlist file copied", async () => {
    const repo = makeRepo();
    // realistic shape: .env is gitignored (that's why worktrees don't get it)
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    sh(["git", "add", ".gitignore"], repo);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore env"], repo);
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const cfgAllow = { envAllowlist: { [repo]: [".env"] } } as unknown as WispConfig;
    const wt = await createWorktree(repo, "tabc12", "my-task", cfgAllow);
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe("wisp/tabc12-my-task");
    expect(existsSync(join(wt.path, ".env"))).toBe(true);
    expect(await isDirty(wt.path)).toBe(false); // gitignored copy doesn't dirty the worktree
  });

  test("non-repo fails loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-notrepo-"));
    await expect(createWorktree(dir, "tx", "x", cfg)).rejects.toThrow(/not a git repository/);
  });

  test("unpushed detection: clean base → false, local commit → true", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tdef34", "unpushed", cfg);
    expect(await hasUnpushedWork(wt.path, wt.branch, wt.base_commit)).toBe(false);
    writeFileSync(join(wt.path, "work.txt"), "w\n");
    sh(["git", "add", "."], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"], wt.path);
    expect(await hasUnpushedWork(wt.path, wt.branch, wt.base_commit)).toBe(true);
  });

  test("commits merged into another local branch count as saved (never pushed anywhere)", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tmrg90", "merged", cfg);
    writeFileSync(join(wt.path, "work.txt"), "w\n");
    sh(["git", "add", "."], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"], wt.path);
    expect(await hasUnpushedWork(wt.path, wt.branch, wt.base_commit)).toBe(true);
    // merge the task branch into the repo's default branch instead of pushing
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "-m", "merge task work", wt.branch], repo);
    expect(await hasUnpushedWork(wt.path, wt.branch, wt.base_commit)).toBe(false);
  });

  test("archive refuses a dirty worktree; force commits the work onto the kept branch and removes", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tghi56", "dirty", cfg);
    writeFileSync(join(wt.path, "uncommitted.txt"), "oops\n");
    expect((await archivePreflight(wt.path, wt.branch, wt.base_commit, false)).refusal).toMatch(/uncommitted/);

    expect((await archivePreflight(wt.path, wt.branch, wt.base_commit, true)).refusal).toBeNull();
    await removeWorktree(repo, wt.path, wt.branch, true);
    expect(existsSync(wt.path)).toBe(false);

    // D3: preserved as a commit on the branch archive keeps, where a person
    // will look for it (`git log <branch>`) — NOT as a stash
    const log = shOut(["git", "log", "--format=%s", "-1", wt.branch], repo).trim();
    expect(log).toBe(ARCHIVE_COMMIT_MESSAGE);
    expect(shOut(["git", "show", "--name-only", "--format=", wt.branch], repo)).toContain("uncommitted.txt");
    // and the whole point of D3: the user's real repo's stash list is untouched
    expect(shOut(["git", "stash", "list"], repo).trim()).toBe("");
  });

  test("a repo that signs every commit and rejects them in a hook still saves the work", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tsig01", "hooked", cfg);
    // both of these would otherwise be able to fail the one step that saves
    // the user's bytes: an unusable signing key, and a hook that says no
    sh(["git", "config", "commit.gpgsign", "true"], repo);
    sh(["git", "config", "user.signingkey", "NOSUCHKEY"], repo);
    // hooks live in the COMMON dir, so this one is the worktree's hook too
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    writeFileSync(join(wt.path, "precious.txt"), "keep me\n");
    await removeWorktree(repo, wt.path, wt.branch, true);
    expect(shOut(["git", "show", "--name-only", "--format=", wt.branch], repo)).toContain("precious.txt");
  });

  test("clean worktree archives without force, committing nothing", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tjkl78", "clean", cfg);
    const before = shOut(["git", "rev-parse", wt.branch], repo).trim();
    expect((await archivePreflight(wt.path, wt.branch, wt.base_commit, false)).refusal).toBeNull();
    await removeWorktree(repo, wt.path, wt.branch, false);
    expect(existsSync(wt.path)).toBe(false);
    expect(shOut(["git", "rev-parse", wt.branch], repo).trim()).toBe(before); // no empty commit
  });
});

/**
 * D1: a worktree git has forgotten is a real state the product used to report
 * two different wrong ways — silently clean in the sidebar, a page of git usage
 * text in the diff pane. worktreeHealth is the one authority both now consult.
 */
describe("worktreeHealth", () => {
  test("a live worktree is ok, with no reason to show", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "thlt01", "healthy", cfg);
    expect(await worktreeHealth(wt.path)).toEqual({ ok: true, kind: "ok", reason: null });
    // a plain repo checkout (a local task's "worktree") is healthy too
    expect((await worktreeHealth(repo)).ok).toBe(true);
  });

  test("a missing directory names the path and the way out", async () => {
    const gone = join(mkdtempSync(join(tmpdir(), "wisp-health-")), "never-existed");
    const health = await worktreeHealth(gone);
    expect(health.ok).toBe(false);
    expect(health.kind).toBe("missing");
    expect(health.reason).toBe(`The worktree directory is gone (${gone}) — archive this task to clear the row.`);
  });

  test("a directory full of files that git no longer tracks says so, and says the files stay", async () => {
    // the reported shape: files remain, with no
    // .git, and no admin entry in the parent repo
    const orphan = mkdtempSync(join(tmpdir(), "wisp-orphan-wt-"));
    writeFileSync(join(orphan, "work.txt"), "the agent's work is still here\n");
    const health = await worktreeHealth(orphan);
    expect(health.ok).toBe(false);
    // the kind is what tells archive the user's bytes are still in there
    expect(health.kind).toBe("detached");
    expect(health.reason).toBe(
      `Git no longer tracks this worktree (${orphan}) — archive this task to clear the row; the files stay on disk.`,
    );
  });

  test("the reason is ONE sentence, never git's usage text", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "wisp-orphan-lines-"));
    const reason = (await worktreeHealth(orphan)).reason!;
    expect(reason.split("\n")).toHaveLength(1);
    expect(reason.length).toBeLessThan(300);
    expect(reason).not.toContain("--no-index");
  });
});

/** D1 part 3: the boundary that stops the NEXT unknown git failure from screaming. */
describe("sanitized git errors", () => {
  test("only the first non-empty line of git's stderr reaches the message", async () => {
    // `git diff <base>` outside a repository is the reported case: a warning
    // line, then ~40 lines of `git diff` usage
    const notARepo = mkdtempSync(join(tmpdir(), "wisp-not-a-repo-"));
    let message = "";
    try {
      await fullDiff(notARepo, "0000000000000000000000000000000000000000");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toStartWith("git diff failed: warning: Not a git repository.");
    // git's own first line stands; the ~40 lines of `git diff` usage behind it
    // are what used to reach the diff pane
    expect(message.split("\n")).toHaveLength(1);
    expect(message).not.toContain("usage:");
    expect(message).not.toContain("--diff-filter");
    expect(message.length).toBeLessThan(220);
  });

  test("a long single line is capped with an ellipsis", async () => {
    const repo = makeRepo();
    // git quotes an unknown revision back at us verbatim, so a 400-char one is
    // a 400-char first line — the cap, not the line split, is what holds here
    let message = "";
    try {
      await fullDiff(repo, "n".repeat(400));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toStartWith("git diff failed: ");
    expect(message).toEndWith("…");
    expect(message.length).toBeLessThan(220);
  });
});

/**
 * The recovery (D1 part 2): the affected task could not be archived at all,
 * because `git worktree remove` on a path git does not know fails and that 409
 * had no way out.
 */
describe("removeWorktree on a worktree git has forgotten", () => {
  /** A real worktree, then its .git file and admin entry destroyed behind git's back. */
  async function forgottenWorktree(): Promise<{ repo: string; path: string; branch: string }> {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tfgt01", "forgotten", cfg);
    writeFileSync(join(wt.path, "the-agent-left-this.txt"), "not tracked by anything\n");
    rmSync(join(wt.path, ".git"), { recursive: true, force: true });
    rmSync(join(repo, ".git", "worktrees"), { recursive: true, force: true });
    return { repo, path: wt.path, branch: wt.branch };
  }

  test("plain archive prunes, keeps the branch, and LEAVES the files, saying where", async () => {
    const { repo, path, branch } = await forgottenWorktree();
    const pre = await archivePreflight(path, branch, null, false);
    expect(pre.health.ok).toBe(false);
    expect(pre.refusal).toBeNull(); // the recovery: never a 409 the user cannot act on
    expect(pre.leftBehind).toContain(path);
    expect(pre.leftBehind).toContain("removing them is your call");

    await removeWorktree(repo, path, branch, false);
    // the row can clear, the branch survives, and the user's bytes are still there
    expect(existsSync(join(path, "the-agent-left-this.txt"))).toBe(true);
    expect(shOut(["git", "branch", "--list", branch], repo).trim()).toContain(branch);
  });

  test("force archive deletes the directory — that is what force is for", async () => {
    const { repo, path, branch } = await forgottenWorktree();
    const pre = await archivePreflight(path, branch, null, true);
    expect(pre.refusal).toBeNull();
    expect(pre.leftBehind).toBeNull();
    await removeWorktree(repo, path, branch, true);
    expect(existsSync(path)).toBe(false);
  });

  test("neither path asks git whether it is dirty or unpushed", async () => {
    const { path, branch } = await forgottenWorktree();
    // left to itself, hasUnpushedWork sees for-each-ref fail, finds no other
    // refs and answers TRUE — which is the 409 the owner was stuck behind
    expect(await hasUnpushedWork(path, branch, null)).toBe(true);
    expect((await archivePreflight(path, branch, null, false)).refusal).toBeNull();
  });

  test("an already-deleted directory is the same story, with nothing to leave behind", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tfgt02", "vanished", cfg);
    rmSync(wt.path, { recursive: true, force: true });
    const pre = await archivePreflight(wt.path, wt.branch, wt.base_commit, false);
    expect(pre.health.reason).toContain("is gone");
    expect(pre.refusal).toBeNull();
    expect(pre.leftBehind).toBeNull(); // no bytes to preserve, so no sentence claiming there are
    await removeWorktree(repo, wt.path, wt.branch, false);
    expect(shOut(["git", "worktree", "list"], repo)).not.toContain(wt.path);
  });
});

/** The teardown hooks get the setup path's timeout and SIGKILL escalation (H4/M3, Q11). */
describe("archive teardown hooks", () => {
  test("both hooks run in the worktree, repo's own first", async () => {
    const repo = makeRepo();
    const marker = join(mkdtempSync(join(tmpdir(), "wisp-teardown-")), "order.txt");
    const withScript = { ...cfg, repos: [{ path: repo, archiveScript: `echo project >> ${marker}` }] };
    const wt = await createWorktree(repo, "ttd001", "teardown", withScript);
    mkdirSync(join(wt.path, ".wisp"), { recursive: true });
    writeFileSync(join(wt.path, ".wisp", "cleanup.sh"), `#!/usr/bin/env bash\necho repo >> ${marker}\n`);
    await removeWorktree(repo, wt.path, wt.branch, true, withScript, "ttd001");
    expect(readFileSync(marker, "utf8")).toBe("repo\nproject\n");
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a hung hook is killed at the timeout and the worktree is still removed", async () => {
    const repo = makeRepo();
    const impatient = { ...cfg, setupTimeoutMinutes: 0.02, repos: [{ path: repo, archiveScript: "sleep 60" }] };
    const wt = await createWorktree(repo, "ttd002", "hung-teardown", impatient);
    const started = Date.now();
    await removeWorktree(repo, wt.path, wt.branch, true, impatient, "ttd002");
    expect(Date.now() - started).toBeLessThan(20_000); // nowhere near the 60s sleep
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a failing hook never strands the worktree — teardown stays best effort", async () => {
    const repo = makeRepo();
    const withScript = { ...cfg, repos: [{ path: repo, archiveScript: "exit 9" }] };
    const wt = await createWorktree(repo, "ttd003", "bad-teardown", withScript);
    await removeWorktree(repo, wt.path, wt.branch, false, withScript, "ttd003");
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("fullDiff (web UI diff pane)", () => {
  test("diff against the base covers committed + unstaged work; untracked files are new-file diffs", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tdif01", "diffs", cfg);
    writeFileSync(join(wt.path, "committed.txt"), "BRANCH_WORK\n");
    sh(["git", "add", "."], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "branch work"], wt.path);
    appendFileSync(join(wt.path, "README.md"), "UNSTAGED_WORK\n");
    writeFileSync(join(wt.path, "scratch.txt"), "UNTRACKED_CONTENT\n");
    const r = await fullDiff(wt.path, wt.base_commit);
    expect(r.truncated).toBe(false);
    expect(r.diff).toContain("BRANCH_WORK"); // committed on the branch
    expect(r.diff).toContain("UNSTAGED_WORK"); // never committed at all
    expect(r.untracked).toEqual(["scratch.txt"]);
    expect(r.diff).toContain("UNTRACKED_CONTENT"); // appended so the pane can show it
    expect(r.diff).toContain("diff --git a/scratch.txt b/scratch.txt");
    expect(r.diff).toContain("--- /dev/null");
  });

  test("untracked nested, empty, and binary files get a renderable patch; gitignored stay out", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tdif04", "untracked-shapes", cfg);
    mkdirSync(join(wt.path, "nested"));
    writeFileSync(join(wt.path, "nested", "new.txt"), "NESTED_UNTRACKED\n");
    writeFileSync(join(wt.path, "empty.txt"), "");
    writeFileSync(join(wt.path, "blob.bin"), Buffer.from([0x00, 0x01, 0xff]));
    writeFileSync(join(wt.path, ".gitignore"), "secret.env\n");
    writeFileSync(join(wt.path, "secret.env"), "SECRET=1\n");
    const r = await fullDiff(wt.path, wt.base_commit);
    expect(r.untracked).toEqual([".gitignore", "blob.bin", "empty.txt", "nested/new.txt"]);
    expect(r.diff).toContain("NESTED_UNTRACKED");
    expect(r.diff).toContain("diff --git a/nested/new.txt b/nested/new.txt");
    expect(r.diff).toContain("diff --git a/empty.txt b/empty.txt");
    expect(r.diff).toContain("Binary files /dev/null and b/blob.bin differ");
    expect(r.diff).not.toContain("SECRET=1");
  });

  test("with no base commit it diffs against HEAD (staged + unstaged only)", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tdif02", "head-diff", cfg);
    writeFileSync(join(wt.path, "committed.txt"), "BRANCH_WORK\n");
    sh(["git", "add", "."], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "branch work"], wt.path);
    appendFileSync(join(wt.path, "README.md"), "UNSTAGED_WORK\n");
    const r = await fullDiff(wt.path, null);
    expect(r.diff).toContain("UNSTAGED_WORK");
    expect(r.diff).not.toContain("BRANCH_WORK"); // committed work is only visible against the base
  });

  test("caps the diff text at 512 KB and flags truncation", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tdif03", "cap", cfg);
    writeFileSync(join(wt.path, "big.txt"), `${"y".repeat(600 * 1024)}\n`);
    sh(["git", "add", "."], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "big"], wt.path);
    const r = await fullDiff(wt.path, wt.base_commit);
    expect(r.truncated).toBe(true);
    expect(r.diff.length).toBe(512 * 1024);
  });
});

describe("statusSummary (web UI sidebar)", () => {
  test("counts dirty files, commits ahead of the base, and unpushed work", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tsta01", "status", cfg);
    expect(await statusSummary(wt.path, wt.branch, wt.base_commit)).toEqual({
      dirtyFiles: 0,
      ahead: 0,
      unpushed: false,
    });
    writeFileSync(join(wt.path, "a.txt"), "a\n");
    writeFileSync(join(wt.path, "b.txt"), "b\n");
    expect((await statusSummary(wt.path, wt.branch, wt.base_commit)).dirtyFiles).toBe(2);
    sh(["git", "add", "a.txt"], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"], wt.path);
    const s = await statusSummary(wt.path, wt.branch, wt.base_commit);
    expect(s).toEqual({ dirtyFiles: 1, ahead: 1, unpushed: true });
  });

  test("a null base commit reports ahead 0", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tsta02", "no-base", cfg);
    const s = await statusSummary(wt.path, wt.branch, null);
    expect(s.ahead).toBe(0);
  });
});

describe("runSetup (.wisp/setup.sh)", () => {
  function repoWithSetup(script: string): string {
    const repo = makeRepo();
    mkdirSync(join(repo, ".wisp"), { recursive: true });
    writeFileSync(join(repo, ".wisp", "setup.sh"), script);
    sh(["git", "add", "."], repo);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add setup"], repo);
    return repo;
  }

  test("no setup script is a no-op", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tns001", "no-setup", cfg);
    await runSetup("tns001", repo, wt.path, {}, cfg); // resolves, does nothing
  });

  test("successful setup runs inside the worktree", async () => {
    const repo = repoWithSetup("#!/usr/bin/env bash\necho hi > setup-ran.txt\n");
    const wt = await createWorktree(repo, "tso002", "setup-ok", cfg);
    await runSetup("tso002", repo, wt.path, {}, cfg);
    expect(existsSync(join(wt.path, "setup-ran.txt"))).toBe(true);
  });

  test("nonzero exit fails loudly with the exit code", async () => {
    const repo = repoWithSetup("#!/usr/bin/env bash\nexit 3\n");
    const wt = await createWorktree(repo, "tsf003", "setup-fail", cfg);
    await expect(runSetup("tsf003", repo, wt.path, {}, cfg)).rejects.toThrow(/setup script failed \(exit 3\)/);
  });

  test("hung setup is killed after setupTimeoutMinutes and fails loudly", async () => {
    const repo = repoWithSetup("#!/usr/bin/env bash\nsleep 60\n");
    const wt = await createWorktree(repo, "tsh004", "setup-hung", cfg);
    const impatient = { ...cfg, setupTimeoutMinutes: 0.02 }; // 1.2s
    const started = Date.now();
    await expect(runSetup("tsh004", repo, wt.path, {}, impatient)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(20_000); // nowhere near the 60s sleep
  });

  // The project-configured script is per-machine; .wisp/setup.sh is the team's.
  // Both run, because dropping either silently changes behaviour for anyone
  // already relying on it.
  test("the project's configured setupScript runs too, after the repo's own", async () => {
    const repo = repoWithSetup("#!/usr/bin/env bash\necho repo >> order.txt\n");
    const withScript = { ...cfg, repos: [{ path: repo, setupScript: "echo project >> order.txt" }] };
    const wt = await createWorktree(repo, "tsc005", "setup-both", withScript);
    await runSetup("tsc005", repo, wt.path, {}, withScript);
    expect(readFileSync(join(wt.path, "order.txt"), "utf8")).toBe("repo\nproject\n");
  });

  test("a configured setupScript runs even with no .wisp/setup.sh", async () => {
    const repo = makeRepo();
    const withScript = { ...cfg, repos: [{ path: repo, setupScript: "echo ran > only.txt" }] };
    const wt = await createWorktree(repo, "tsc006", "setup-only", withScript);
    await runSetup("tsc006", repo, wt.path, {}, withScript);
    expect(existsSync(join(wt.path, "only.txt"))).toBe(true);
  });

  test("a failing configured setupScript fails the task loudly", async () => {
    const repo = makeRepo();
    const withScript = { ...cfg, repos: [{ path: repo, setupScript: "exit 7" }] };
    const wt = await createWorktree(repo, "tsc007", "setup-bad", withScript);
    await expect(runSetup("tsc007", repo, wt.path, {}, withScript)).rejects.toThrow(
      /project setup script failed \(exit 7\)/,
    );
  });
});

/**
 * The .env problem: git does not carry ignored files, so a fresh worktree
 * cannot run without them.
 */
describe("copyFiles (untracked files carried into a new worktree)", () => {
  function repoWithEnv(): string {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".env*\nnode_modules/\n");
    writeFileSync(join(repo, ".env"), "ROOT=1\n");
    mkdirSync(join(repo, "backend"), { recursive: true });
    writeFileSync(join(repo, "backend", ".env"), "BACKEND=1\n");
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", ".env"), "NOPE=1\n");
    sh(["git", "add", "."], repo);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore env"], repo);
    return repo;
  }

  test("a pattern with no slash matches at ANY depth, and never inside node_modules", async () => {
    const repo = repoWithEnv();
    const { files, truncated } = await matchCopyFiles(repo, [".env*"]);
    expect(files).toEqual([".env", "backend/.env"]);
    expect(truncated).toBe(false);
  });

  test("a pattern WITH a slash is anchored at the repo root", async () => {
    const repo = repoWithEnv();
    expect((await matchCopyFiles(repo, ["backend/.env"])).files).toEqual(["backend/.env"]);
    // anchored, so the root .env is not swept in by this one
    expect((await matchCopyFiles(repo, ["backend/*"])).files).toEqual(["backend/.env"]);
  });

  test("an unparseable pattern costs that pattern, not the whole create", async () => {
    const repo = repoWithEnv();
    // ".env" carries no slash, so it too matches at any depth
    expect((await matchCopyFiles(repo, ["[", ".env"])).files).toEqual([".env", "backend/.env"]);
  });

  test("createWorktree copies the matches, making nested directories on the way", async () => {
    const repo = repoWithEnv();
    const withCopy = { ...cfg, repos: [{ path: repo, copyFiles: [".env*"] }] };
    const wt = await createWorktree(repo, "tcp001", "copy", withCopy);
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("ROOT=1\n");
    expect(readFileSync(join(wt.path, "backend", ".env"), "utf8")).toBe("BACKEND=1\n");
    expect(existsSync(join(wt.path, "node_modules", "pkg", ".env"))).toBe(false);
  });

  test("the older envAllowlist still works, and unions with copyFiles", async () => {
    const repo = repoWithEnv();
    writeFileSync(join(repo, "legacy.txt"), "old\n");
    const both = { ...cfg, envAllowlist: { [repo]: ["legacy.txt"] }, repos: [{ path: repo, copyFiles: [".env*"] }] };
    const wt = await createWorktree(repo, "tcp002", "copy-both", both);
    expect(existsSync(join(wt.path, "legacy.txt"))).toBe(true);
    expect(existsSync(join(wt.path, ".env"))).toBe(true);
  });
});

/** local mode: adopt the checkout, create nothing, remove nothing. */
describe("localWorktree", () => {
  test("adopts the checkout on its current branch, with HEAD as the base", async () => {
    const repo = makeRepo();
    sh(["git", "checkout", "-q", "-b", "feature/x"], repo);
    const wt = await localWorktree(repo);
    expect(wt.path).toBe(repo);
    expect(wt.branch).toBe("feature/x");
    expect(wt.base_commit).toMatch(/^[0-9a-f]{40}$/);
    // nothing was created: no wisp/ branch appeared
    expect(shOut(["git", "branch", "--list", "wisp/*"], repo).trim()).toBe("");
  });

  test("refuses a detached HEAD, where there is no branch to record", async () => {
    const repo = makeRepo();
    const head = shOut(["git", "rev-parse", "HEAD"], repo).trim();
    sh(["git", "checkout", "-q", head], repo);
    await expect(localWorktree(repo)).rejects.toThrow(/detached HEAD/);
  });
});

/**
 * The PR-review shape, reproduced with local git only: an "origin" the task's
 * repo tracks, a main that advances past the worktree's creation commit, and a
 * feature branch forked from that NEWER main and checked out into the
 * worktree — exactly what `gh pr checkout` leaves behind.
 */
function makeForkScenario(): { worktree: string; baseCommit: string; forkPoint: string; mainTip: string } {
  const commit = (repo: string, message: string): string => {
    sh(["git", "add", "-A"], repo);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message], repo);
    return Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: repo, stdout: "pipe" }).stdout.toString().trim();
  };

  const origin = mkdtempSync(join(tmpdir(), "wisp-origin-"));
  sh(["git", "init", "-q", "-b", "main"], origin);
  writeFileSync(join(origin, "README.md"), "hi\n");
  const baseCommit = commit(origin, "init");

  // main advances — these are the commits that must NOT show up in the diff
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(origin, `main-only-${i}.txt`), `landed on main ${i}\n`);
    commit(origin, `main ${i}`);
  }
  const forkPoint = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: origin, stdout: "pipe" })
    .stdout.toString()
    .trim();

  // the PR branch, forked from the NEW main tip
  sh(["git", "checkout", "-q", "-b", "pr-branch"], origin);
  writeFileSync(join(origin, "pr-change.txt"), "the PR's one change\n");
  commit(origin, "the PR");
  sh(["git", "checkout", "-q", "main"], origin);
  // main moves once more after the fork, so the fork point is not main's tip
  writeFileSync(join(origin, "main-after-fork.txt"), "later\n");
  const mainTip = commit(origin, "main after fork");

  // the task's worktree: cloned at the OLD base, then the PR branch checked out
  const worktree = mkdtempSync(join(tmpdir(), "wisp-fork-wt-"));
  sh(["git", "clone", "-q", origin, worktree], "/tmp");
  sh(["git", "checkout", "-q", "pr-branch"], worktree);
  return { worktree, baseCommit, forkPoint, mainTip };
}

describe("resolveDiffBase (GitHub's base, not the worktree's creation commit)", () => {
  test("a branch checked out into the worktree diffs from its fork point, not the old base", async () => {
    const { worktree, baseCommit, forkPoint } = makeForkScenario();
    expect(await resolveDiffBase(worktree, baseCommit)).toBe(forkPoint);
  });

  test("the diff pane then shows only what the branch did", async () => {
    const { worktree, baseCommit } = makeForkScenario();
    const r = await fullDiff(worktree, baseCommit);
    // the PR's file, and NONE of the commits that landed on main in between
    expect(r.diff).toContain("pr-change.txt");
    expect(r.diff).not.toContain("main-only-0.txt");
    expect(r.diff).not.toContain("main-only-1.txt");
    expect(r.diff).not.toContain("main-after-fork.txt");
  });

  test("the reported base is the one actually diffed from", async () => {
    const { worktree, baseCommit, forkPoint } = makeForkScenario();
    expect((await fullDiff(worktree, baseCommit)).base).toBe(forkPoint);
  });

  test("`ahead` counts from the same base the diff uses", async () => {
    const { worktree, baseCommit } = makeForkScenario();
    // one commit on the PR branch — not the four that separate it from baseCommit
    expect((await statusSummary(worktree, "pr-branch", baseCommit)).ahead).toBe(1);
  });

  test("uncommitted work still shows, on top of the branch's own changes", async () => {
    const { worktree, baseCommit } = makeForkScenario();
    appendFileSync(join(worktree, "README.md"), "edited by the agent\n");
    const r = await fullDiff(worktree, baseCommit);
    expect(r.diff).toContain("edited by the agent");
    expect(r.diff).toContain("pr-change.txt");
  });

  test("an ordinary task is unchanged — its base IS the fork point", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tbase1", "ordinary", cfg);
    writeFileSync(join(wt.path, "work.txt"), "the agent's work\n");
    sh(["git", "add", "-A"], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"], wt.path);
    // no remote at all: every upstream lookup fails and the base is kept
    expect(await resolveDiffBase(wt.path, wt.base_commit)).toBe(wt.base_commit);
    expect((await fullDiff(wt.path, wt.base_commit)).diff).toContain("work.txt");
  });

  test("a base commit unrelated to HEAD degrades to their fork point, never a cross-history diff", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "tbase2", "orphan", cfg);
    const forkPoint = wt.base_commit;
    // an orphan branch shares no history with the base; merge-base finds nothing
    sh(["git", "checkout", "-q", "--orphan", "detached-history"], wt.path);
    writeFileSync(join(wt.path, "only.txt"), "orphan\n");
    sh(["git", "add", "-A"], wt.path);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "orphan"], wt.path);
    // nothing better exists, so it falls back to the recorded base rather than throwing
    expect(await resolveDiffBase(wt.path, forkPoint)).toBe(forkPoint);
  });
});
