/**
 * SIGTERM and SIGINT must reach the daemon's graceful stop. Every service
 * restart and self-update ends the daemon this way, and the signal handler
 * used to stop only the terminal shells and exit, so the workflow and
 * autopilot runtimes and the tracked request work never settled. A real
 * `wisp serve` is driven here, because a signal handler only runs in a
 * process of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTERS_PATH, CONFIG_PATH } from "../src/config";
import { serve, stopForExit } from "../src/daemon";
import { acquireHomeOwnership } from "../src/home-lock";
import { shutDown } from "../src/shutdown";
import { createTask, freeSlot, newTaskId, runningTurn, setTaskFields, transition } from "../src/store";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** `home` restarts a daemon in a home an earlier one used, as a service manager would. */
async function startDaemon(existingHome?: string) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "wisp-shutdown-"));
  if (!existingHome) homes.push(home);
  const port = freePort();
  const token = "shutdown-test-token";
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, host: "127.0.0.1", token, webhooks: [], repos: [] }));
  const proc = Bun.spawn({
    cmd: [process.execPath, "src/index.ts", "serve"],
    cwd: resolve(import.meta.dir, ".."),
    // Hermetic: no harness may launch (so model discovery fails at once, as
    // it does with nothing installed), and nothing reads the user's home.
    env: { ...process.env, WISP_HOME: home, HOME: home, PATH: "/usr/bin:/bin", WISP_LAUNCH_POLICY: "block" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`daemon exited ${proc.exitCode}:\n${await stderr}`);
    if (Date.now() > deadline) { proc.kill("SIGKILL"); throw new Error(`daemon never answered:\n${await stderr}`); }
    const health = await fetch(`${base}/api/health`).catch(() => null);
    if (health?.ok) break;
    await Bun.sleep(50);
  }
  return { proc, base, token, stderr, home };
}

const ISO_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

describe("a daemon's run is visible afterwards", () => {
  test("diagnostics report when this run started, and a graceful stop leaves no marker", async () => {
    const daemon = await startDaemon();
    const response = await fetch(`${daemon.base}/api/diagnostics`, { headers: { authorization: `Bearer ${daemon.token}` } });
    const report = (await response.json()) as { pid: number; startedAt: string; uptimeSeconds: number };
    expect(report.pid).toBe(daemon.proc.pid);
    expect(Date.parse(report.startedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(existsSync(join(daemon.home, "daemon-run.json"))).toBe(true);
    daemon.proc.kill("SIGTERM");
    await daemon.proc.exited;
    const log = await daemon.stderr;
    expect(existsSync(join(daemon.home, "daemon-run.json"))).toBe(false);
    // the daemon's own lines carry a timestamp, ahead of the unchanged tag
    const own = log.split("\n").filter((line) => line.includes("[wisp] SIGTERM"));
    expect(own.length).toBeGreaterThan(0);
    for (const line of own) expect(line).toMatch(ISO_PREFIX);
  }, 30_000);

  test("a killed daemon's successor logs and records the unclean exit", async () => {
    const first = await startDaemon();
    const firstPid = first.proc.pid;
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    await first.stderr;

    const second = await startDaemon(first.home);
    try {
      const exits = JSON.parse(readFileSync(join(first.home, "daemon-exits.json"), "utf8")) as { exits: { pid: number }[] };
      expect(exits.exits.map((exit) => exit.pid)).toEqual([firstPid]);
    } finally {
      second.proc.kill("SIGTERM");
      await second.proc.exited;
    }
    const log = await second.stderr;
    expect(log).toContain(`[wisp] the previous daemon (pid ${firstPid},`);
    expect(log).toContain("exited without shutting down");
  }, 40_000);
});

describe("a signalled daemon", () => {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    test(`${signal} runs the graceful stop, then stops the shells and exits ${code}`, async () => {
      const daemon = await startDaemon();
      // An open event stream, as every browser tab keeps, must not hold the
      // stop to its deadline. The stream sends nothing until its first event,
      // so its response is not awaited; the pause lets the request land.
      const reader = new AbortController();
      const events = fetch(`${daemon.base}/api/events`, {
        headers: { authorization: `Bearer ${daemon.token}` },
        signal: reader.signal,
      }).catch(() => null);
      await Bun.sleep(300);
      const started = Date.now();
      daemon.proc.kill(signal);
      const exitCode = await daemon.proc.exited;
      const stopMs = Date.now() - started;
      const log = await daemon.stderr;
      reader.abort();
      await events;

      expect(exitCode).toBe(code);
      expect(log).toContain(`[wisp] ${signal}: stopping the daemon`);
      expect(log).toContain(`[wisp] ${signal}: daemon stopped`);
      expect(log).not.toContain("exiting anyway");
      expect(log.indexOf(`[wisp] ${signal}: daemon stopped`)).toBeLessThan(log.indexOf(`[wisp] ${signal}: terminal shells stopped`));
      expect(stopMs).toBeLessThan(5_000);
    }, 20_000);
  }
});

describe("the shutdown sequence", () => {
  test("a signal during boot, before there is a stop to run, still marks the exit clean", async () => {
    const steps: string[] = [];
    await shutDown("SIGTERM", {
      stop: null,
      killShells: async () => { steps.push("shells"); },
      endRun: () => { steps.push("run ended"); },
      exit: (exitCode) => { steps.push(`exit ${exitCode}`); },
      log: () => {},
    });
    expect(steps).toEqual(["shells", "run ended", "exit 143"]);
  });

  test("a graceful stop that hangs is cut off at the deadline, and the shells still stop", async () => {
    const lines: string[] = [];
    const steps: string[] = [];
    await shutDown("SIGTERM", {
      stop: () => new Promise<void>(() => undefined),
      killShells: async () => { steps.push("shells"); },
      exit: (exitCode) => { steps.push(`exit ${exitCode}`); },
      deadlineMs: 20,
      log: (line) => lines.push(line),
    });
    expect(steps).toEqual(["shells", "exit 143"]);
    expect(lines).toContain("[wisp] SIGTERM: graceful stop did not finish within 0.02 s; exiting anyway");
  });

  test("a graceful stop that fails is logged, and the shells still stop", async () => {
    const lines: string[] = [];
    const steps: string[] = [];
    await shutDown("SIGINT", {
      stop: async () => { throw new Error("stop broke"); },
      killShells: async () => { steps.push("shells"); },
      exit: (exitCode) => { steps.push(`exit ${exitCode}`); },
      log: (line) => lines.push(line),
    });
    expect(steps).toEqual(["shells", "exit 130"]);
    expect(lines.some((line) => line.startsWith("[wisp] SIGINT: graceful stop failed: ") && line.includes("stop broke"))).toBe(true);
    expect(lines).not.toContain("[wisp] SIGINT: daemon stopped");
  });

  test("a signal during boot, before the server exists, still stops the shells", async () => {
    const steps: string[] = [];
    await shutDown("SIGTERM", {
      stop: null,
      killShells: async () => { steps.push("shells"); },
      exit: (exitCode) => { steps.push(`exit ${exitCode}`); },
      log: () => undefined,
    });
    expect(steps).toEqual(["shells", "exit 143"]);
  });
});

describe("stopping a daemon that is about to exit", () => {
  test("does not wait for a running turn, and releases ownership", async () => {
    const token = "shutdown-turn-token";
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: 18710, host: "127.0.0.1", token, webhooks: [], repos: [] }));
    // a harness that outlives any reasonable stop: bash is an allowed stand-in
    writeFileSync(ADAPTERS_PATH, JSON.stringify({ sleeper: { bin: "bash", exec: ["-c", "sleep 60"], parse: { format: "text" } } }));
    const worktree = mkdtempSync(join(tmpdir(), "wisp-shutdown-turn-"));
    homes.push(worktree);
    const server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("no probes here"); }, modelProbeTimeoutMs: 100 });
    const id = newTaskId();
    let pid: number | null = null;
    try {
      createTask({ id, title: "Shutdown fixture", repo_path: worktree, harness: "sleeper", model: null, slot: freeSlot() });
      setTaskFields(id, { worktree_path: worktree });
      transition(id, "done");
      // through the API, so the turn watcher is the daemon's tracked work
      const sent = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${id}/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "keep going" }),
      });
      expect(sent.ok).toBe(true);
      const deadline = Date.now() + 5_000;
      while (!runningTurn(id)?.pid && Date.now() < deadline) await Bun.sleep(20);
      pid = runningTurn(id)?.pid ?? null;
      expect(pid).not.toBeNull();

      const started = Date.now();
      await stopForExit(server);
      expect(Date.now() - started).toBeLessThan(2_000);
      // ownership is free for the next daemon, and the turn was left running for it
      acquireHomeOwnership().release();
      expect(runningTurn(id)).not.toBeNull();
    } finally {
      if (pid !== null) {
        try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      }
      rmSync(ADAPTERS_PATH, { force: true });
    }
  }, 20_000);
});
