/**
 * GET /api/projects/entries — the composer's `@` list of one project folder.
 *
 * What is pinned here is the boundary and the filter, not the list's order of
 * operations: only a project in the Projects list may be listed, `dir` can
 * never leave its root (absolute, `..`, or a symlink that resolves outside),
 * and `.git` plus everything git ignores is absent while tracked files stay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectEntriesResponse } from "../../shared/api/project-entries";
import { CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";
import { ENTRY_CAP, listProjectEntries, projectDirSegments, SCAN_CAP } from "../src/project-entries";
import { GIT, type IgnoreGit } from "../src/project-ignore";

const token = "project-entries-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

async function startServer(repos: string[]): Promise<string> {
  const cfg: WispConfig = {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos,
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  server = await serve({ port: 0 });
  return `http://127.0.0.1:${server.port}`;
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

/** A project with ignored folders and files, one tracked file an ignore pattern matches, and links in and out. */
function makeProject(): { root: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-project-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-outside-")));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  git(root, ["init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\ndist\nsrc/generated/\n");
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "src/components"), { recursive: true });
  mkdirSync(join(root, "src/generated"));
  writeFileSync(join(root, "README.md"), "hi\n");
  writeFileSync(join(root, "debug.log"), "noise\n");
  writeFileSync(join(root, "kept.log"), "tracked despite *.log\n");
  writeFileSync(join(root, "src/index.ts"), "export {}\n");
  writeFileSync(join(root, "src/components/button.tsx"), "export {}\n");
  git(root, ["add", "-f", "kept.log"]);
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  symlinkSync(join(root, "src"), join(root, "src-link"));
  return { root, outside };
}

async function entries(base: string, project: string, dir?: string, q?: string): Promise<Response> {
  const query = new URLSearchParams({ project });
  if (dir !== undefined) query.set("dir", dir);
  if (q !== undefined) query.set("q", q);
  return fetch(`${base}/api/projects/entries?${query}`, { headers: { authorization: `Bearer ${token}` } });
}

async function listing(response: Response): Promise<ProjectEntriesResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as ProjectEntriesResponse;
}

describe("GET /api/projects/entries", () => {
  test("lists the root: folders first, without .git or anything git ignores", async () => {
    const { root } = makeProject();
    const base = await startServer([root]);
    const body = await listing(await entries(base, root));
    expect(body.project).toBe(root);
    expect(body.dir).toBe("");
    expect(body.truncated).toBe(false);
    expect(body.entries).toEqual([
      { name: "src", kind: "dir" },
      { name: "src-link", kind: "dir" },
      { name: ".gitignore", kind: "file" },
      { name: "kept.log", kind: "file" },
      { name: "README.md", kind: "file" },
    ]);
  });

  test("lists a nested folder and applies the ignore rules there too", async () => {
    const { root } = makeProject();
    const base = await startServer([root]);
    const body = await listing(await entries(base, root, "src/"));
    expect(body.dir).toBe("src");
    expect(body.entries).toEqual([
      { name: "components", kind: "dir" },
      { name: "index.ts", kind: "file" },
    ]);
  });

  test("a symlink that stays inside the project is followed", async () => {
    const { root } = makeProject();
    const base = await startServer([root]);
    const body = await listing(await entries(base, root, "src-link"));
    // and filtered by its real path: src/generated/ is ignored there too
    expect(body.entries.map((entry) => entry.name)).toEqual(["components", "index.ts"]);
  });

  test("refuses dir values that leave the project", async () => {
    const { root, outside } = makeProject();
    const base = await startServer([root]);
    for (const dir of ["..", "src/../..", "../" + outside.split("/").pop(), "src/./../../etc"]) {
      const response = await entries(base, root, dir);
      expect(response.status, dir).toBe(400);
    }
    for (const dir of [outside, "/etc", "\\etc"]) {
      const response = await entries(base, root, dir);
      expect(response.status, dir).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("relative");
    }
    const escaped = await entries(base, root, "escape");
    expect(escaped.status).toBe(403);
    expect(await escaped.text()).not.toContain("secret.txt");
    expect((await entries(base, root, ".git")).status).toBe(400);
  });

  test("lists only projects in the Projects list", async () => {
    const { root, outside } = makeProject();
    const base = await startServer([root]);
    expect((await entries(base, outside)).status).toBe(404);
    expect((await entries(base, "relative/path")).status).toBe(400);
    expect((await entries(base, `${root}/src`)).status).toBe(404);
    expect((await entries(base, root, "missing")).status).toBe(404);
    expect((await entries(base, root, "README.md")).status).toBe(404);
  });

  test("needs the bearer token", async () => {
    const { root } = makeProject();
    const base = await startServer([root]);
    const response = await fetch(`${base}/api/projects/entries?project=${encodeURIComponent(root)}`);
    expect(response.status).toBe(401);
  });

  test("caps the rows and says so", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-many-")));
    for (let i = 0; i < ENTRY_CAP + 5; i += 1) writeFileSync(join(root, `f${i}.txt`), "");
    const base = await startServer([root]);
    const body = await listing(await entries(base, root));
    expect(body.entries).toHaveLength(ENTRY_CAP);
    expect(body.truncated).toBe(true);
  });

  test("a link into .git is neither listed nor listable; any other link is judged by its own name", async () => {
    const { root } = makeProject();
    symlinkSync(join(root, ".git"), join(root, "gitlink"));
    symlinkSync(join(root, ".git/HEAD"), join(root, "head-link"));
    symlinkSync(join(root, "node_modules"), join(root, "deps"));
    const base = await startServer([root]);
    const names = (await listing(await entries(base, root))).entries.map((entry) => entry.name);
    expect(names).not.toContain("gitlink");
    expect(names).not.toContain("head-link");
    // `deps` leads to the ignored node_modules, but its own name is not ignored
    expect(names).toContain("deps");
    const refused = await entries(base, root, "gitlink");
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("HEAD");
    expect((await entries(base, root, "gitlink/refs")).status).toBe(403);
  });

  test("a link is ignored by its own name", async () => {
    const { root } = makeProject();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\ndist\nsrc/generated/\nbuild\n");
    symlinkSync(join(root, "src"), join(root, "build"));
    const base = await startServer([root]);
    const names = (await listing(await entries(base, root))).entries.map((entry) => entry.name);
    expect(names).not.toContain("build");
    expect(names).toContain("src-link");
  });

  test("a submodule's own rules hide its ignored entries, and a link into it hides nothing it should not", async () => {
    const { root } = makeProject();
    // a real submodule: mode 160000 in the root's index, with its own .gitignore
    const upstream = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-upstream-")));
    git(upstream, ["init", "-q"]);
    writeFileSync(join(upstream, ".gitignore"), "node_modules/\n*.log\n");
    writeFileSync(join(upstream, "index.ts"), "export {}\n");
    git(upstream, ["add", "-A"]);
    git(upstream, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "vendor"]);
    const staged = Bun.spawnSync({ cmd: ["git", "ls-files", "-s", "vendor"], cwd: root, stdout: "pipe" });
    expect(staged.stdout.toString()).toStartWith("160000 ");
    mkdirSync(join(root, "vendor/node_modules"));
    writeFileSync(join(root, "vendor/debug.log"), "noise\n");
    // the root's own build alias (ignored by name) and a link whose target only the submodule can answer for
    writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\ndist\nsrc/generated/\nbuild\n");
    symlinkSync(join(root, "src"), join(root, "build"));
    symlinkSync(join(root, "vendor/index.ts"), join(root, "vendor-entry"));
    const base = await startServer([root]);

    const vendor = (await listing(await entries(base, root, "vendor"))).entries.map((entry) => entry.name);
    expect(vendor).toContain("index.ts");
    expect(vendor).not.toContain("node_modules");
    expect(vendor).not.toContain("debug.log");

    const top = (await listing(await entries(base, root))).entries.map((entry) => entry.name);
    expect(top).toContain("vendor");
    expect(top).toContain("vendor-entry");
    for (const hidden of ["node_modules", "debug.log", "build", "dist"]) expect(top, hidden).not.toContain(hidden);
  });

  test("a farm of 2,000 links into 2,000 folders costs one git process", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-farm-")));
    git(root, ["init", "-q"]);
    mkdirSync(join(root, "links"));
    for (let i = 0; i < 2_000; i += 1) {
      mkdirSync(join(root, "dirs", `d${i}`), { recursive: true });
      writeFileSync(join(root, "dirs", `d${i}`, "x"), "");
      symlinkSync(join(root, "dirs", `d${i}`, "x"), join(root, "links", `l${i}`));
    }
    let calls = 0;
    let inFlight = 0;
    let peak = 0;
    const counting: IgnoreGit = {
      async checkIgnore(cwd, paths) {
        calls += 1;
        peak = Math.max(peak, (inFlight += 1));
        try {
          return await GIT.checkIgnore(cwd, paths);
        } finally {
          inFlight -= 1;
        }
      },
      async outsideRepository(cwd) {
        calls += 1;
        return GIT.outsideRepository(cwd);
      },
    };
    const body = await listProjectEntries(root, "links", "", counting);
    expect("entries" in body && body.entries.length).toBe(ENTRY_CAP);
    expect(calls).toBeLessThanOrEqual(2);
    expect(peak).toBe(1);
  });

  test("a name that looks like pathspec magic is still just a name", async () => {
    const { root } = makeProject();
    writeFileSync(join(root, ":(exclude)x.log"), "");
    writeFileSync(join(root, ":kept.ts"), "");
    const base = await startServer([root]);
    const names = (await listing(await entries(base, root))).entries.map((entry) => entry.name);
    expect(names).toContain(":kept.ts");
    expect(names).not.toContain(":(exclude)x.log");
    expect(names).not.toContain("debug.log");
  });

  test("a repository git cannot read fails the listing, never serves it unfiltered", async () => {
    const { root } = makeProject();
    writeFileSync(join(root, ".git/config"), "[core\n\tbroken = = =\n");
    const base = await startServer([root]);
    const response = await entries(base, root);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("couldn't read this project's ignore rules");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("debug.log");
  });

  test("q narrows before the cap, so a name past the first rows is reachable", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-filter-")));
    for (let i = 0; i <= ENTRY_CAP; i += 1) writeFileSync(join(root, `file${String(i).padStart(3, "0")}.txt`), "");
    const base = await startServer([root]);
    const capped = await listing(await entries(base, root));
    expect(capped.truncated).toBe(true);
    expect(capped.entries.map((entry) => entry.name)).not.toContain("file500.txt");
    const narrowed = await listing(await entries(base, root, "", "FILE500"));
    expect(narrowed).toMatchObject({ truncated: false, entries: [{ name: "file500.txt", kind: "file" }] });
  });

  test("every entry read counts toward the scan cap, even ones it leaves out", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-dangling-")));
    for (let i = 0; i <= SCAN_CAP; i += 1) symlinkSync(join(root, `missing-${i}`), join(root, `dangling-${i}`));
    const base = await startServer([root]);
    expect(await listing(await entries(base, root))).toEqual({
      project: root,
      dir: "",
      entries: [],
      truncated: false,
      incompleteAfter: SCAN_CAP,
    });
  });

  test("a folder that is not a git checkout still lists, hiding only .git", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-entries-plain-")));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "a.txt"), "");
    const base = await startServer([root]);
    const body = await listing(await entries(base, root));
    expect(body.entries).toEqual([
      { name: "node_modules", kind: "dir" },
      { name: "a.txt", kind: "file" },
    ]);
  });
});

describe("projectDirSegments", () => {
  test("normalizes the root and empty segments", () => {
    expect(projectDirSegments("")).toEqual([]);
    expect(projectDirSegments(".")).toEqual([]);
    expect(projectDirSegments("src//components/./")).toEqual(["src", "components"]);
  });

  test("refuses escapes, absolute paths, .git and NUL", () => {
    for (const dir of ["..", "a/../b", "/abs", "\\abs", ".git", "a/.git/hooks", "a\0b", "a\\..\\b"]) {
      expect(Array.isArray(projectDirSegments(dir)), dir).toBe(false);
    }
  });
});
