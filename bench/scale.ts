/**
 * `bun run bench:scale`: what the daemon's reads cost at heavy-use scale.
 * Informational only: nothing here is gated in CI (that is `bun run bench`).
 *
 * Seeds a home shaped like an orchestrating workflow: one long task
 * (default 1000 turns) and one parent with subtasks (default 10 × 30 turns),
 * each in a live worktree. Then it measures, against a real `wisp serve`,
 * the reads that grow with turns and subtasks: the full task detail every
 * `wisp wait` / `send` / `result` poll reads, the conversation page the UI
 * refetches per event, the diff, the subtasks list, and one `wisp wait`
 * round over every subtask. It prints bytes (identity and gzip), median
 * time, and git spawns per request.
 *
 *   bun bench/scale.ts [--turns 1000] [--subtasks 10] [--subtask-turns 30] [--json <file>]
 *
 * The home is a wisp-bench-* directory under the system temp root, deleted
 * afterwards (kept on failure, for its daemon.log). Compare runs before and
 * after a change to the routes it reads.
 */
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchEnv, freePort, initHome, makeRepository } from "./daemon";
import type { ScalePlan } from "./scale-seed";
import { assertBenchHome, HOME_PREFIX } from "./shared";

const args = process.argv.slice(2);
const numberArg = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const LONG_TURNS = numberArg("turns", 1000);
const SUBTASKS = numberArg("subtasks", 10);
const SUBTASK_TURNS = numberArg("subtask-turns", 30);
const PARENT_TURNS = 40;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;

interface Row {
  name: string;
  status: number;
  rawBytes: number;
  gzipBytes: number;
  medianMs: number;
  gitPerRequest: number;
}

const ENTRY = join(import.meta.dir, "..", "wispd", "src", "index.ts");
const home = assertBenchHome(mkdtempSync(join(tmpdir(), HOME_PREFIX)));
let kept = false;
let daemon: ReturnType<typeof Bun.spawn> | null = null;
try {
  const port = await freePort();
  const token = initHome(home, port);
  const fixture = makeRepository(home, 2 + SUBTASKS);
  const plan: ScalePlan = {
    repo: fixture.repo,
    base: fixture.base,
    worktrees: fixture.worktrees,
    longTurns: LONG_TURNS,
    parentTurns: PARENT_TURNS,
    subtasks: SUBTASKS,
    subtaskTurns: SUBTASK_TURNS,
  };
  const seeded = Bun.spawnSync([process.execPath, join(import.meta.dir, "scale-seed.ts"), JSON.stringify(plan)], { env: benchEnv(home), stdout: "pipe", stderr: "pipe" });
  if (seeded.exitCode !== 0) throw new Error(`seeding failed:\n${seeded.stderr.toString()}`);

  // Count the daemon's git spawns through a PATH shim, as bench/daemon.ts does.
  const shims = join(home, "shims");
  const spawnLog = join(home, "spawns.log");
  mkdirSync(shims);
  writeFileSync(spawnLog, "");
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is not on PATH");
  writeFileSync(join(shims, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${spawnLog}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(shims, "git"), 0o755);
  const spawns = (): number => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;

  const output = openSync(join(home, "daemon.log"), "a");
  daemon = Bun.spawn([process.execPath, ENTRY, "serve"], {
    cwd: home,
    env: benchEnv(home, { PATH: `${shims}:${process.env.PATH ?? ""}` }),
    stdout: output,
    stderr: output,
  });
  closeSync(output);
  const origin = `http://127.0.0.1:${port}`;
  const started = performance.now();
  while (!(await fetch(`${origin}/api/health`).catch(() => null))?.ok) {
    if (daemon.exitCode !== null) throw new Error(`the daemon exited ${daemon.exitCode} before answering`);
    if (performance.now() - started > 30_000) throw new Error(`the daemon never answered on ${origin}`);
    await Bun.sleep(20);
  }

  const get = async (path: string, encoding: string) => {
    const t = performance.now();
    const response = await fetch(origin + path, { headers: { authorization: `Bearer ${token}`, "accept-encoding": encoding }, decompress: false });
    const body = await response.arrayBuffer();
    return { ms: performance.now() - t, bytes: body.byteLength, status: response.status };
  };
  const rows: Row[] = [];
  const measure = async (name: string, path: string): Promise<void> => {
    await get(path, "gzip"); // warm: a first read may fill a cache the rest reuse
    writeFileSync(spawnLog, "");
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await get(path, "gzip"));
    const gitPerRequest = spawns() / runs.length;
    const plain = await get(path, "identity");
    const medianMs = runs.map((run) => run.ms).sort((a, b) => a - b)[2]!;
    rows.push({ name, status: plain.status, rawBytes: plain.bytes, gzipBytes: runs[0]!.bytes, medianMs: Number(medianMs.toFixed(1)), gitPerRequest });
  };

  await measure(`wisp wait poll: detail, ${LONG_TURNS}-turn task`, "/api/tasks/long");
  await measure(`wisp wait poll: detail, ${SUBTASK_TURNS}-turn subtask`, "/api/tasks/sub0");
  await measure(`UI: conversation page, ${LONG_TURNS}-turn task`, "/api/tasks/long/conversation?limit=50");
  await measure("UI: conversation older page", `/api/tasks/long/conversation?limit=50&before=${Math.ceil(LONG_TURNS / 2)}`);
  await measure("UI: conversation, parent", "/api/tasks/parent/conversation?limit=50");
  await measure(`UI: subtasks of parent (${SUBTASKS})`, "/api/tasks/parent/subtasks");
  await measure("UI: live task list", "/api/tasks?cleanup=1");
  await measure("UI: status", "/api/status");
  await measure("UI: diff", "/api/tasks/long/diff");
  // ⌘⇧F: a needle in no row, one in a few, and one in nearly every row
  await measure("UI: search, no match", "/api/search?q=zzqxv-no-such-text");
  await measure("UI: search, a phrase in a few rows", `/api/search?q=${encodeURIComponent("build function error")}`);
  await measure("UI: search, a common word", "/api/search?q=function");

  // One round of `wisp wait sub0 … subN`: it reads every task once per WAIT_POLL_MS.
  writeFileSync(spawnLog, "");
  const roundStarted = performance.now();
  let roundBytes = 0;
  for (let i = 0; i < SUBTASKS; i++) roundBytes += (await get(`/api/tasks/sub${i}`, "identity")).bytes;
  const round = { subtasks: SUBTASKS, ms: Math.round(performance.now() - roundStarted), rawBytes: roundBytes, gitSpawns: spawns() };

  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(`\n${"read".padEnd(width)}  status  ${"raw".padStart(9)}  ${"gzip".padStart(8)}  ${"median".padStart(8)}  git/req`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${String(row.status).padStart(6)}  ${String(row.rawBytes).padStart(9)}  ${String(row.gzipBytes).padStart(8)}  ${`${row.medianMs}ms`.padStart(8)}  ${row.gitPerRequest}`);
  }
  console.log(`\none \`wisp wait\` round over ${round.subtasks} subtasks: ${round.ms} ms, ${round.rawBytes} bytes, ${round.gitSpawns} git spawns (repeats every 2 s while waiting)`);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ plan: { longTurns: LONG_TURNS, subtasks: SUBTASKS, subtaskTurns: SUBTASK_TURNS }, reads: rows, waitRound: round }, null, 2)}\n`);
} catch (error) {
  kept = true;
  console.error(`bench:scale failed; its home is kept at ${home}\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await daemon.exited;
  }
  if (!kept) rmSync(home, { recursive: true, force: true });
}
