import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("read-only directories in the trash are deleted too", async () => {
    const entry = join(TRASH_ROOT, `readonly-${Date.now()}`);
    mkdirSync(join(entry, "pkg", "mod"), { recursive: true });
    writeFileSync(join(entry, "pkg", "mod", "go.mod"), "module x\n");
    chmodSync(join(entry, "pkg", "mod"), 0o555);
    chmodSync(join(entry, "pkg"), 0o555);
    await sweepTrash();
    expect(existsSync(entry)).toBe(false);
  });
});
