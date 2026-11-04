import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { WispConfig } from "../src/config";
import { createWorktree } from "../src/worktree";
import { removeWorktree } from "../src/worktree-removal";
import { moveToTrash, sweepTrash, TRASH_ROOT } from "../src/worktree-trash";

const cfg = { envAllowlist: {}, setupTimeoutMinutes: 5 } as WispConfig;
const FIXTURE_DIRS: string[] = [];

function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  FIXTURE_DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

function makeRepo(): string {
  const repo = fixtureDir("wisp-trash-repo-");
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(["add", "."], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  return repo;
}

/** Trash entries made from this worktree; other files' entries may share the directory. */
function trashed(worktree: string): string[] {
  if (!existsSync(TRASH_ROOT)) return [];
  return readdirSync(TRASH_ROOT).filter(name => name.startsWith(`${basename(worktree)}-`));
}

const listed = (repo: string, worktree: string) => git(["worktree", "list", "--porcelain"], repo).out
  .split("\n").some(line => line.startsWith("worktree ") && line.endsWith(`/${basename(worktree)}`));

describe("removing a worktree through the trash", () => {
  test("the path and git's entry go at once; the bytes go in the background, never past a symlink", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ttrsh1", cfg);
    for (let d = 0; d < 5; d++) {
      mkdirSync(join(wt.path, "node_modules", `pkg${d}`), { recursive: true });
      for (let f = 0; f < 20; f++) writeFileSync(join(wt.path, "node_modules", `pkg${d}`, `f${f}.js`), "x");
    }
    writeFileSync(join(wt.path, ".gitignore"), "node_modules\n");
    const outside = fixtureDir("wisp-trash-outside-");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    symlinkSync(outside, join(wt.path, "node_modules", "link"));

    await removeWorktree(repo, wt.path, wt.branch, true);
    expect(existsSync(wt.path)).toBe(false);
    expect(listed(repo, wt.path)).toBe(false);
    expect(git(["rev-parse", "--verify", wt.branch], repo).ok).toBe(true);
    // the uncommitted .gitignore was saved on the kept branch before the move
    expect(git(["show", "--name-only", "--format=", wt.branch], repo).out).toContain(".gitignore");

    await sweepTrash();
    expect(trashed(wt.path)).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("a main checkout is refused before anything is saved or moved", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "dirty.txt"), "mine\n");
    await expect(removeWorktree(repo, repo, "main", true)).rejects.toThrow(/main checkout/);
    expect(readFileSync(join(repo, "dirty.txt"), "utf8")).toBe("mine\n");
    expect(git(["log", "--format=%s"], repo).out.trim()).toBe("init");
  });

  test("a locked worktree, or a directory inside one, is refused and stays", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ttrsh2", cfg);
    mkdirSync(join(wt.path, "sub"));
    await expect(removeWorktree(repo, join(wt.path, "sub"), wt.branch, true)).rejects.toThrow(/not its top level/);
    git(["worktree", "lock", wt.path], repo);
    await expect(removeWorktree(repo, wt.path, wt.branch, true)).rejects.toThrow(/locked/);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(trashed(wt.path)).toEqual([]);
  });

  test("a worktree of another repository is refused", async () => {
    const repo = makeRepo(), other = makeRepo();
    const wt = await createWorktree(repo, "ttrsh3", cfg);
    await expect(removeWorktree(other, wt.path, wt.branch, true)).rejects.toThrow(/different repository/);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  test("a worktree outside Wisp's worktree root is still removed by git, in place", async () => {
    const repo = makeRepo();
    const path = join(fixtureDir("wisp-trash-elsewhere-"), "tree");
    expect(git(["worktree", "add", "-q", "-b", "elsewhere", path], repo).ok).toBe(true);
    await removeWorktree(repo, path, "elsewhere", true);
    expect(existsSync(path)).toBe(false);
    expect(listed(repo, path)).toBe(false);
    expect(trashed(path)).toEqual([]);
  });

  test("interrupted after the move, before the prune: the retry finishes it", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ttrsh4", cfg);
    expect(await moveToTrash(wt.path)).not.toBeNull();
    expect(listed(repo, wt.path)).toBe(true);
    await removeWorktree(repo, wt.path, wt.branch, false, { save: false });
    expect(listed(repo, wt.path)).toBe(false);
    await sweepTrash();
    expect(trashed(wt.path)).toEqual([]);
  });

  test("read-only directories in the trash are deleted too, in either layout", async () => {
    // a read-only directory holding files (Go's module cache), and a read-only
    // parent over a read-only child: Bun fails these with different codes
    const flat = join(TRASH_ROOT, `readonly-flat-${Date.now()}`);
    mkdirSync(join(flat, "mod@v1"), { recursive: true });
    writeFileSync(join(flat, "mod@v1", "go.mod"), "module x\n");
    chmodSync(join(flat, "mod@v1"), 0o555);
    const nested = join(TRASH_ROOT, `readonly-nested-${Date.now()}`);
    mkdirSync(join(nested, "pkg", "mod"), { recursive: true });
    writeFileSync(join(nested, "pkg", "mod", "go.mod"), "module x\n");
    chmodSync(join(nested, "pkg", "mod"), 0o555);
    chmodSync(join(nested, "pkg"), 0o555);
    await sweepTrash();
    expect(existsSync(flat)).toBe(false);
    expect(existsSync(nested)).toBe(false);
  });

  // Concurrent calls share one sweep and it misses nothing. This does not pin
  // the finishing-sweep window itself (the second entry exists before the
  // first readdir); that ordering is argued in sweepUntilQuiet's comment.
  test("concurrent sweeps share one pass and leave nothing behind", async () => {
    const first = join(TRASH_ROOT, `concurrent-a-${Date.now()}`);
    mkdirSync(first, { recursive: true });
    const running = sweepTrash();
    const second = join(TRASH_ROOT, `concurrent-b-${Date.now()}`);
    mkdirSync(second, { recursive: true });
    await Promise.all([running, sweepTrash()]);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test("a trash that is a symlink is never swept through", async () => {
    const outside = fixtureDir("wisp-trash-target-");
    writeFileSync(join(outside, "precious.txt"), "keep\n");
    const aside = `${TRASH_ROOT}-aside-${Date.now()}`;
    if (existsSync(TRASH_ROOT)) renameSync(TRASH_ROOT, aside);
    try {
      symlinkSync(outside, TRASH_ROOT);
      await sweepTrash();
      expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep\n");
      // nor is anything moved into it, where the sweeper would never reach it
      const doomed = fixtureDir("wisp-trash-doomed-");
      expect(await moveToTrash(doomed)).toBeNull();
      expect(existsSync(doomed)).toBe(true);
      expect(readdirSync(outside)).toEqual(["precious.txt"]);
    } finally {
      unlinkSync(TRASH_ROOT);
      if (existsSync(aside)) renameSync(aside, TRASH_ROOT);
    }
  });
});
