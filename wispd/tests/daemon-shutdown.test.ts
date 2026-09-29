/**
 * SIGTERM and SIGINT must reach the daemon's graceful stop. Every service
 * restart and self-update ends the daemon this way, and the signal handler
 * used to stop only the terminal shells and exit, so the workflow and
 * autopilot runtimes and the tracked request work never settled. A real
 * `wisp serve` is driven here, because a signal handler only runs in a
 * process of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function startDaemon() {
  const home = mkdtempSync(join(tmpdir(), "wisp-shutdown-"));
  homes.push(home);
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
  return { proc, base, token, stderr };
}

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
