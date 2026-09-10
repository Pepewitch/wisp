import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";

/**
 * The `wisp project` verbs, driven end-to-end: the real CLI entry spawned as a
 * subprocess against the real daemon on an ephemeral port. The CLI reads
 * CONFIG_PATH fresh per invocation, so after serve() has picked its port we
 * rewrite the config with it — the daemon already holds its own copy.
 */

const token = "cli-project-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

const entry = join(import.meta.dir, "..", "src", "index.ts");

function writeConfig(port: number, repos: WispConfig["repos"] = []): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port,
      host: "127.0.0.1",
      token,
      webhooks: [],
      repos,
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
}

async function startDaemon(): Promise<void> {
  writeConfig(18710);
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("probe disabled in tests");
    },
    modelProbeTimeoutMs: 100,
  });
  // the CLI reads the config file, not the booted daemon, so it needs the real port
  writeConfig(server.port);
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

// async spawn, never spawnSync: the daemon under test lives in THIS process,
// and a synchronous spawn would freeze the event loop that has to answer the
// CLI's HTTP requests — a self-deadlock
async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ["bun", entry, ...args],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "wisp-cli-project-"));
}

describe("wisp project show / set", () => {
  test("show prints every settings field; unset fields print as -", async () => {
    await startDaemon();
    const path = makeProject();
    expect((await run(["project", "add", path, "--name", "Demo"])).exitCode).toBe(0);

    const out = await run(["project", "show", path]);
    expect(out.exitCode).toBe(0);
    // exact, not toContain: this is the test that catches a field added to
    // `project set` and never taught to `show`
    expect(out.stdout).toBe(
      [
        `name: Demo`,
        `path: ${path}`,
        `exists: yes`,
        `setup: -`,
        `archive: -`,
        `base: - (origin/HEAD)`,
        `copy: -`,
        ``,
      ].join("\n"),
    );
  });

  test("set then show round-trips name, setup, archive, and every --copy glob", async () => {
    await startDaemon();
    const path = makeProject();
    expect((await run(["project", "add", path])).exitCode).toBe(0);

    const set = await run([
      "project",
      "set",
      path,
      "--name",
      "Renamed",
      "--setup",
      "bun install",
      "--archive",
      "git clean -fdx",
      "--copy",
      ".env",
      "--copy",
      "*.local",
    ]);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toBe("");

    const out = await run(["project", "show", path]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("name: Renamed\n");
    expect(out.stdout).toContain("setup: bun install\n");
    expect(out.stdout).toContain("archive: git clean -fdx\n");
    expect(out.stdout).toContain("copy: .env, *.local\n");
  });

  /**
   * The whole `--base` CLI surface, end to end. Worth its own test because
   * the flag first shipped unparsable: the handlers read it as a string
   * while VALUE_FLAGS still made it a boolean, so `--base <ref>` always
   * refused itself and no test noticed. `show` has to print it too, or there
   * is no way to confirm what `set` just wrote.
   */
  test("--base round-trips through set and show, and --clear-base restores the default", async () => {
    await startDaemon();
    const path = makeProject();
    expect((await run(["project", "add", path])).exitCode).toBe(0);

    // unset is the normal state, and show says what unset MEANS rather than
    // rendering it as a blank someone feels obliged to fill in
    let out = await run(["project", "show", path]);
    expect(out.stdout).toContain("base: - (origin/HEAD)\n");

    const set = await run(["project", "set", path, "--base", "origin/develop"]);
    expect(set.exitCode).toBe(0);
    expect(set.stderr).toBe("");
    out = await run(["project", "show", path]);
    expect(out.stdout).toContain("base: origin/develop\n");

    // PATCH, like every other field: setting a script leaves the base alone
    await run(["project", "set", path, "--setup", "bun install"]);
    out = await run(["project", "show", path]);
    expect(out.stdout).toContain("base: origin/develop\n");

    const cleared = await run(["project", "set", path, "--clear-base"]);
    expect(cleared.exitCode).toBe(0);
    out = await run(["project", "show", path]);
    expect(out.stdout).toContain("base: - (origin/HEAD)\n");
    expect(out.stdout).toContain("setup: bun install\n"); // untouched by the clear

    const both = await run(["project", "set", path, "--base", "x", "--clear-base"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("mutually exclusive");
  });

  test("set is a PATCH: untouched fields survive, and the clear flags empty theirs", async () => {
    await startDaemon();
    const path = makeProject();
    await run(["project", "set", path, "--setup", "bun install", "--archive", "rm -rf .next", "--copy", ".env"]);

    // clearing only --archive must leave setup and copy alone (the gear
    // dialog's PATCH semantics, inherited through the same route)
    const cleared = await run(["project", "set", path, "--clear-archive"]);
    expect(cleared.exitCode).toBe(0);
    let out = await run(["project", "show", path]);
    expect(out.stdout).toContain("setup: bun install\n");
    expect(out.stdout).toContain("archive: -\n");
    expect(out.stdout).toContain("copy: .env\n");

    const clearedAll = await run(["project", "set", path, "--clear-setup", "--clear-copy"]);
    expect(clearedAll.exitCode).toBe(0);
    out = await run(["project", "show", path]);
    expect(out.stdout).toContain("setup: -\n");
    expect(out.stdout).toContain("copy: -\n");
  });

  test("show on an unknown project names the path and exits nonzero", async () => {
    await startDaemon();
    const out = await run(["project", "show", "/no/such/project"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("project not found: /no/such/project");
  });

  test("a value-less --setup is a usage error, not a silent boolean", async () => {
    await startDaemon();
    const out = await run(["project", "set", makeProject(), "--setup"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("--setup requires a value");
  });

  test("--setup and --clear-setup together are rejected instead of guessing", async () => {
    await startDaemon();
    const out = await run(["project", "set", makeProject(), "--setup", "x", "--clear-setup"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("--setup and --clear-setup are mutually exclusive");
  });

  test("`wisp project` with no or an unknown action prints usage and exits 1", async () => {
    await startDaemon();
    for (const args of [["project"], ["project", "bogus"]]) {
      const out = await run(args);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("usage: wisp project");
    }
  });
});

describe("wisp project rm", () => {
  test("unregisters a configured project; a second rm names the path", async () => {
    await startDaemon();
    const path = makeProject();
    expect((await run(["project", "add", path])).exitCode).toBe(0);

    const removed = await run(["project", "rm", path]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain(`project removed: ${path}`);

    const listed = await run(["project", "ls"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain(path);

    const again = await run(["project", "rm", path]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain(`project not found in config repos: ${path}`);
  });
});

describe("wisp project list", () => {
  // the top-level command took both spellings from the start, so `project
  // list` reading as an unknown action was pure surprise (#136)
  test("is an alias for ls, printing the same listing", async () => {
    await startDaemon();
    const path = makeProject();
    expect((await run(["project", "add", path, "--name", "Aliased"])).exitCode).toBe(0);

    const ls = await run(["project", "ls"]);
    const list = await run(["project", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stderr).toBe("");
    expect(list.stdout).toContain(path);
    expect(list.stdout).toBe(ls.stdout);
  });
});
