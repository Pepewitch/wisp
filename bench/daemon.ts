/**
 * The spawned-daemon half of the benchmark: a real `wisp serve` on the seeded
 * home, with `git`, `gh` and `ps` on its PATH replaced by shims that log each
 * spawn before running the real binary. No harness runs: the launch policy is
 * `block`, and nothing here starts a turn.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Measurement } from "./shared";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "wispd", "src", "index.ts");
const COUNTED = ["git", "gh", "ps"];

/**
 * What every process the bench starts runs with. Git reads no user or system
 * config, so a contributor's signing, hooks or fsmonitor can neither break
 * the fixture nor change a spawn count.
 */
export function benchEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WISP_HOME: home,
    WISP_LAUNCH_POLICY: "block",
    GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid",
    GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid",
    ...extra,
  };
  for (const key of ["NODE_ENV", "WISP_DEV_HOME", "FACTORY_API_KEY", "DROID_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY"]) delete env[key];
  return env;
}

function run(cmd: string[], env: Record<string, string>, cwd = ROOT): string {
  const result = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

export interface Fixture {
  repo: string;
  base: string;
  worktrees: string[];
}

/** A repository with an origin, and one dirty worktree per live task, as task creation leaves them. */
export function makeRepository(home: string, live: number): Fixture {
  const env = benchEnv(home);
  const repo = join(home, "repo");
  mkdirSync(repo);
  run(["git", "init", "-q", "-b", "main"], env, repo);
  for (let i = 0; i < 100; i++) writeFileSync(join(repo, `file${i}.txt`), `line ${i}\n`);
  run(["git", "add", "-A"], env, repo);
  run(["git", "commit", "-qm", "initial"], env, repo);
  run(["git", "clone", "-q", "--bare", repo, join(home, "origin.git")], env);
  run(["git", "remote", "add", "origin", join(home, "origin.git")], env, repo);
  run(["git", "fetch", "-q", "origin"], env, repo);
  run(["git", "remote", "set-head", "origin", "main"], env, repo);
  const worktrees = Array.from({ length: live }, (_, i) => {
    const path = join(home, "worktrees", `live${i}`);
    run(["git", "worktree", "add", "-q", "-b", `wisp/live${i}`, path, "main"], env, repo);
    writeFileSync(join(path, "notes.txt"), "uncommitted\n");
    return path;
  });
  return { repo, base: run(["git", "rev-parse", "HEAD"], env, repo), worktrees };
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export function initHome(home: string, port: number): string {
  run([process.execPath, ENTRY, "init", "--port", String(port)], benchEnv(home));
  return (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { token: string }).token;
}

/** Resolves false after `ms`, without a timer left holding the process open. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a log stream until its first turn-end; the byte count is what a client downloaded to get there. */
async function streamBytesUntilTurnEnd(url: string, token: string): Promise<number> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let tail = "";
  try {
    for (;;) {
      const next = reader.read();
      if (!(await within(next, 15_000))) throw new Error(`${url} sent no turn-end within 15 s`);
      const { value, done } = await next;
      if (done) throw new Error(`${url} ended before a turn-end`);
      bytes += value.byteLength;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-256);
      if (tail.includes("event: turn-end")) return bytes;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function daemonMeasurements(home: string, port: number, token: string, live: number): Promise<Measurement[]> {
  const spawnLog = join(home, "spawns.log");
  const shims = join(home, "shims");
  mkdirSync(shims);
  for (const name of COUNTED) {
    const real = Bun.which(name);
    if (!real) continue;
    const shim = join(shims, name);
    writeFileSync(shim, `#!/bin/sh\nprintf '%s %s %s\\n' ${name} "$1" "$2" >> '${spawnLog}'\nexec '${real}' "$@"\n`);
    chmodSync(shim, 0o755);
  }
  writeFileSync(spawnLog, "");
  const spawned = (): string[] => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean);
  const resetSpawns = (): void => writeFileSync(spawnLog, "");

  const origin = `http://127.0.0.1:${port}`;
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const timed = async (path: string): Promise<number> => {
    const started = performance.now();
    await (await api(path)).arrayBuffer();
    return Math.round(performance.now() - started);
  };

  const logPath = join(home, "daemon.log");
  const output = openSync(logPath, "a");
  const started = performance.now();
  const daemon = Bun.spawn([process.execPath, ENTRY, "serve"], {
    cwd: home,
    env: benchEnv(home, { PATH: `${shims}:${process.env.PATH ?? ""}` }),
    stdout: output,
    stderr: output,
  });
  closeSync(output);
  try {
    for (;;) {
      if (daemon.exitCode !== null) throw new Error(`the daemon exited ${daemon.exitCode} before answering:\n${readFileSync(logPath, "utf8")}`);
      if ((await fetch(`${origin}/api/health`).catch(() => null))?.ok) break;
      if (performance.now() - started > 30_000) throw new Error(`the daemon never answered on ${origin}`);
      await Bun.sleep(20);
    }
    const bootMs = Math.round(performance.now() - started);

    // The first status asks git about every live task; after that, one
    // task's event must cost that task's probe alone, however many are live.
    resetSpawns();
    const cold = await api("/api/status");
    if (!cold.ok) throw new Error(`/api/status answered ${cold.status}`);
    await cold.arrayBuffer();
    const coldSpawns = spawned().length;
    resetSpawns();
    const renamed = await api("/api/tasks/live1", { method: "PATCH", body: JSON.stringify({ title: "Bench task renamed" }) });
    if (!renamed.ok) throw new Error(`renaming a task answered ${renamed.status}: ${await renamed.text()}`);
    await (await api("/api/status")).arrayBuffer();
    const afterEvent = spawned();

    const streamBytes = await streamBytesUntilTurnEnd(`${origin}/api/tasks/live0/log/stream?format=activity&follow=live`, token);

    const searchMs: number[] = [];
    for (let i = 0; i < 5; i++) searchMs.push(await timed("/api/search?q=zzqxv-no-such-text"));
    const search = timed("/api/search?q=zzqxv-no-such-text");
    const healthDuringSearchMs = await timed("/api/health");
    await search;

    return [
      { name: "daemon.statusAfterOneEvent.spawns", value: afterEvent.length, unit: "spawns", detail: afterEvent.join("; ") },
      { name: "daemon.finishedTaskStream.bytes", value: streamBytes, unit: "bytes" },
      { name: "daemon.statusCold.spawns", value: coldSpawns, unit: `spawns for ${live} live tasks`, informational: true },
      { name: "time.daemon.bootMs", value: bootMs, unit: "ms", informational: true },
      { name: "time.daemon.searchMissMs", value: searchMs.sort((a, b) => a - b)[2]!, unit: "ms", informational: true },
      { name: "time.daemon.healthDuringSearchMs", value: healthDuringSearchMs, unit: "ms", informational: true },
    ];
  } catch (error) {
    throw new Error(`${String(error)}\n--- end of ${logPath} ---\n${readFileSync(logPath, "utf8").slice(-4000)}`, { cause: error });
  } finally {
    daemon.kill("SIGTERM");
    if (!(await within(daemon.exited, 10_000))) daemon.kill("SIGKILL");
  }
}
