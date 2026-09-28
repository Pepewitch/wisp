import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { briefHelp } from "../src/cli-brief-help";

const WISPD = resolve(import.meta.dir, "..");
const ROOT = resolve(WISPD, "..");

function run(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  // this suite may itself run inside a Wisp turn: never let its own task or binding leak in
  const { NODE_ENV: _node, WISP_BRIEF_RUN: _run, WISP_TASK_ID: _task, ...inherited } = process.env;
  const merged: Record<string, string | undefined> = { ...inherited, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete merged[key];
  const result = Bun.spawnSync({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: WISPD,
    env: merged as Record<string, string>,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exit: result.exitCode, out: Buffer.from(result.stdout).toString("utf8"), err: Buffer.from(result.stderr).toString("utf8") };
}

/** `run`, without blocking this process — the stub daemon below lives in it. */
async function runLive(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  const { NODE_ENV: _node, WISP_BRIEF_RUN: _run, WISP_TASK_ID: _task, ...inherited } = process.env;
  const child = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: WISPD,
    env: { ...inherited, ...env } as Record<string, string>,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, out, err };
}

describe("wisp brief help needs no home, daemon or credentials", () => {
  test("both help forms work in a read-only HOME with no WISP_HOME, and create nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "wisp-brief-help-"));
    chmodSync(home, 0o500);
    try {
      for (const args of [["brief"], ["brief", "--help"], ["brief", "-h"], ["brief", "help"]]) {
        const r = run(args, { HOME: home, WISP_HOME: undefined });
        expect(r.exit).toBe(0);
        expect(r.err).toBe("");
        expect(r.out).toContain("brief set --stdin");
      }
      const set = run(["brief", "set", "--help"], { HOME: home, WISP_HOME: undefined });
      expect(set.exit).toBe(0);
      expect(set.out).toContain("alternativesNote");
      expect(existsSync(join(home, ".wisp"))).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test("the primary help stays within 300 words", () => {
    expect(briefHelp().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(300);
  });

  test("set without --stdin prints its usage instead of waiting on a terminal", () => {
    const home = join(mkdtempSync(join(tmpdir(), "wisp-brief-usage-")), "absent");
    const r = run(["brief", "set"], { WISP_HOME: home });
    expect(r.exit).toBe(2);
    expect(r.err).toContain("brief set --stdin");
    expect(existsSync(home)).toBe(false);
  });

  test("wisp-dev answers help without initializing its development home", () => {
    const dev = join(mkdtempSync(join(tmpdir(), "wisp-brief-dev-")), "dev-home");
    for (const args of [["brief", "--help"], ["brief"], ["brief", "set", "--help"]]) {
      const result = Bun.spawnSync({
        cmd: ["sh", "wispd/scripts/wisp-dev", ...args],
        cwd: ROOT,
        env: { ...process.env, WISP_DEV_HOME: dev, WISP_DEV_PORT: "18799", NODE_ENV: undefined } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toContain("wisp-dev brief set --stdin");
    }
    expect(existsSync(join(dev, "config.json"))).toBe(false);
  });
});

describe("wisp brief set", () => {
  let home: string;
  let port: number;
  let mode: "saved" | "conflict" | "disabled" | "old-daemon" | "hang" = "saved";
  const seen: unknown[] = [];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    home = join(mkdtempSync(join(tmpdir(), "wisp-brief-set-")), "home");
    // init refuses a port something already listens on, so reserve one, init, then serve it
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = probe.port;
    probe.stop(true);
    const init = run(["init", "--port", String(port)], { WISP_HOME: home });
    expect(init.err).toBe("");
    expect(init.exit).toBe(0);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(req) {
        seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
        if (mode === "hang") return new Promise<Response>(() => {});
        if (mode === "conflict") return Response.json({ kind: "conflict", error: "a different revision" }, { status: 409 });
        if (mode === "disabled") return Response.json({ kind: "skipped", reason: "disabled" });
        if (mode === "old-daemon") return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ kind: "saved", revision: 1 });
      },
    });
  });

  afterAll(() => server.stop(true));

  const valid = JSON.stringify({ version: 1, outcome: "Fixed.", remaining: [] });
  const bound = () => ({ WISP_HOME: home, WISP_TASK_ID: "tabc23", WISP_BRIEF_RUN: "br_0123" });

  test("a valid brief reaches the bound task with the run id and revision 0", async () => {
    mode = "saved";
    seen.length = 0;
    const r = await runLive(["brief", "set", "--stdin"], bound(), valid);
    expect(r).toEqual({ exit: 0, out: "Brief saved (revision 1).\n", err: "" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: "/api/tasks/tabc23/brief",
      body: { runId: "br_0123", expectedRevision: 0, payload: { version: 1, outcome: "Fixed.", remaining: [] } },
    });
    expect((seen[0] as { auth: string }).auth).toStartWith("Bearer ");
  });

  test("--replace sends the named revision", async () => {
    mode = "saved";
    seen.length = 0;
    await runLive(["brief", "set", "--stdin", "--replace", "3"], bound(), valid);
    expect(seen[0]).toMatchObject({ body: { expectedRevision: 3 } });
    expect((await runLive(["brief", "set", "--stdin", "--replace", "0"], bound(), valid)).exit).toBe(2);
  });

  test("a conflict or a disabled task is a final, successful skip — never a retry", async () => {
    mode = "conflict";
    seen.length = 0;
    const conflict = await runLive(["brief", "set", "--stdin", "--replace", "1"], bound(), valid);
    expect(conflict.exit).toBe(0);
    expect(conflict.out).toContain("Brief skipped");
    expect(conflict.out).toContain("Do not retry");
    expect(seen).toHaveLength(1);
    mode = "disabled";
    expect(await runLive(["brief", "set", "--stdin"], bound(), valid)).toMatchObject({ exit: 0, out: "Brief skipped: briefs are off for this task. Continue normally.\n" });
  });

  test("a mistake in the agent's own JSON exits 1, names the field, and never echoes the payload", async () => {
    seen.length = 0;
    const secret = "do-not-echo-this-text";
    const bad = await runLive(["brief", "set", "--stdin"], bound(), JSON.stringify({ version: 1, outcome: secret, remaining: "none" }));
    expect(bad.exit).toBe(1);
    expect(bad.err).toContain("remaining must be an array");
    expect(bad.err).not.toContain(secret);
    const broken = await runLive(["brief", "set", "--stdin"], bound(), `{"outcome": "${secret}"`);
    expect(broken.exit).toBe(1);
    expect(broken.err).toContain("not valid JSON");
    expect(broken.err).not.toContain(secret);
    const oversized = await runLive(["brief", "set", "--stdin"], bound(), "x".repeat(13 * 1024));
    expect(oversized.exit).toBe(1);
    expect(seen).toHaveLength(0);
  });

  test("a turn that was never bound is told so, successfully", async () => {
    const r = await runLive(["brief", "set", "--stdin"], { WISP_HOME: home, WISP_TASK_ID: "tabc23" }, valid);
    expect(r).toMatchObject({ exit: 0, out: "Brief skipped: this turn was not asked for a brief. Continue normally.\n" });
  });

  test("an older daemon and a daemon that never answers both end in one line, the second within the timeout", async () => {
    mode = "old-daemon";
    const old = await runLive(["brief", "set", "--stdin"], bound(), valid);
    expect(old.exit).toBe(1);
    expect(old.err).toBe("Brief not saved: this Wisp daemon does not support task briefs. Continue without it.\n");
    mode = "hang";
    const started = Date.now();
    const hung = await runLive(["brief", "set", "--stdin"], bound(), valid);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(hung.exit).toBe(1);
    expect(hung.err).toContain("did not answer within 5000 ms");
    expect(hung.err).toContain("Continue without it.");
  }, 20000);
});
