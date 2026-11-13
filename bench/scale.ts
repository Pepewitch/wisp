/**
 * `bun run bench:scale`: what the daemon's reads cost at heavy-use scale.
 * Informational only: nothing here is gated in CI (that is `bun run bench`).
 *
 * Seeds a home shaped like an orchestrating workflow: one long task
 * (default 1000 turns) and one parent with subtasks (default 10 × 30 turns),
 * each in a live worktree. Then it measures, against a real `wisp serve`,
 * the reads that grow with turns and subtasks: the full task detail
 * `wisp show` reads, the task row `wisp wait` polls and the page
 * `wisp result` reads, the conversation page the UI refetches per event, the
 * diff and its summary (the long task's worktree carries about 600 KB of
 * changes), the subtasks list, one `wisp wait` round over every subtask, and
 * what one settled turn's history stream sends. It prints bytes (identity
 * and gzip), median time, and git spawns per request.
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
import { assertBenchHome, HOME_PREFIX, text } from "./shared";

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
  // A long task's worktree is rarely clean: every tracked file rewritten and
  // a few new ones, about 600 KB of diff, past the Changes pane's 512 KiB cap.
  const longWorktree = fixture.worktrees[0]!;
  for (let i = 0; i < 100; i++) writeFileSync(join(longWorktree, `file${i}.txt`), `${text(5_000)}\n`);
  for (let i = 0; i < 10; i++) writeFileSync(join(longWorktree, `new${i}.txt`), `${text(10_000)}\n`);
  // and its latest turn wrote a large log, the transcript a history load must not be sent
  writeFileSync(join(home, "logs", `long-turn${LONG_TURNS}.out.log`), `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: text(2_000) }] } })}\n`.repeat(1_500));

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

  // The CLI's reads: the full detail `wisp show` prints, and the task row and
  // newest page that `wait`, `send` and `result` read. An older daemon
  // ignores `view=` and answers the full detail.
  await measure(`wisp show: detail, ${LONG_TURNS}-turn task`, "/api/tasks/long");
  await measure(`wisp wait poll: ${LONG_TURNS}-turn task`, "/api/tasks/long?view=summary");
  await measure(`wisp wait poll: ${SUBTASK_TURNS}-turn subtask`, "/api/tasks/sub0?view=summary");
  await measure(`wisp result: newest page, ${LONG_TURNS}-turn task`, "/api/tasks/long/conversation?limit=10");
  await measure(`UI: conversation page, ${LONG_TURNS}-turn task`, "/api/tasks/long/conversation?limit=50");
  await measure("UI: conversation older page", `/api/tasks/long/conversation?limit=50&before=${Math.ceil(LONG_TURNS / 2)}`);
  await measure("UI: conversation, parent", "/api/tasks/parent/conversation?limit=50");
  await measure(`UI: subtasks of parent (${SUBTASKS})`, "/api/tasks/parent/subtasks");
  await measure("UI: live task list", "/api/tasks?cleanup=1");
  await measure("UI: status", "/api/status");
  await measure("UI: diff", "/api/tasks/long/diff");
  await measure("UI: diff summary (Changes hint)", "/api/tasks/long/diff/summary");

  // One settled turn's history (`turn=1`, no follow), read to a second past
  // its turn-end: everything a history load is sent before it closes.
  const turnHistory = async (): Promise<{ rawBytes: number }> => {
    const response = await fetch(`${origin}/api/tasks/long/log/stream?format=activity&turn=1`, { headers: { authorization: `Bearer ${token}`, "accept-encoding": "identity" } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let rawBytes = 0;
    let tail = "";
    let ended = false;
    let deadline = performance.now() + 30_000;
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - performance.now())).then(() => null)]);
        if (next === null || next.done) break;
        rawBytes += next.value.byteLength;
        tail = (tail + decoder.decode(next.value, { stream: true })).slice(-64);
        if (!ended && tail.includes("event: turn-end")) {
          ended = true;
          deadline = performance.now() + 1_000;
        }
      }
    } finally {
      await reader.cancel();
    }
    return { rawBytes };
  };
  const history = await turnHistory();

  // One round of `wisp wait sub0 … subN`: it reads every task once per WAIT_POLL_MS.
  writeFileSync(spawnLog, "");
  const roundStarted = performance.now();
  let roundBytes = 0;
  for (let i = 0; i < SUBTASKS; i++) roundBytes += (await get(`/api/tasks/sub${i}?view=summary`, "identity")).bytes;
  const round = { subtasks: SUBTASKS, ms: Math.round(performance.now() - roundStarted), rawBytes: roundBytes, gitSpawns: spawns() };

  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(`\n${"read".padEnd(width)}  status  ${"raw".padStart(9)}  ${"gzip".padStart(8)}  ${"median".padStart(8)}  git/req`);
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${String(row.status).padStart(6)}  ${String(row.rawBytes).padStart(9)}  ${String(row.gzipBytes).padStart(8)}  ${`${row.medianMs}ms`.padStart(8)}  ${row.gitPerRequest}`);
  }
  console.log(`\none \`wisp wait\` round over ${round.subtasks} subtasks: ${round.ms} ms, ${round.rawBytes} bytes, ${round.gitSpawns} git spawns (repeats every 2 s while waiting)`);
  console.log(`turn 1's history stream (turn=1, no follow), to a second after its turn-end: ${history.rawBytes} bytes`);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ plan: { longTurns: LONG_TURNS, subtasks: SUBTASKS, subtaskTurns: SUBTASK_TURNS }, reads: rows, waitRound: round, turnHistory: history }, null, 2)}\n`);
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
