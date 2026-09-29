/**
 * `bun run bench`: structural performance budgets for CI, plus timings for
 * people. See bench/budgets.json for what is enforced and how to change it.
 *
 *   bun bench/run.ts [--json <file>]
 *
 * Everything runs in a fresh wisp-bench-* directory under the system temp
 * root, deleted afterwards (kept on failure, for its daemon.log).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleMeasurements } from "./bundle";
import { benchEnv, daemonMeasurements, freePort, initHome, makeRepository } from "./daemon";
import { assertBenchHome, HOME_PREFIX, type Measurement } from "./shared";

/** Scale: small enough to run on every pull request in seconds. */
const LIVE_TASKS = 12;
const ARCHIVED_TASKS = 188;
const TURNS_PER_TASK = 20;
/** The finished transcript a live-only stream must not replay. */
const TRANSCRIPT_BYTES = 2 * 1024 * 1024;

function seedAndMeasureDatabase(home: string, repo: string, base: string, worktrees: string[]): Measurement[] {
  const plan = { repo, base, worktrees, archived: ARCHIVED_TASKS, turns: TURNS_PER_TASK, transcriptBytes: TRANSCRIPT_BYTES };
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "db.ts"), JSON.stringify(plan)], {
    env: benchEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`seeding failed:\n${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim().split("\n").pop()!) as Measurement[];
}

function check(results: Measurement[], budgets: Record<string, number>): string[] {
  const failures: string[] = [];
  const measured = new Map(results.map((result) => [result.name, result]));
  for (const name of Object.keys(budgets)) {
    if (!measured.has(name)) failures.push(`${name}: has a budget but was not measured (renamed or removed?)`);
  }
  const width = Math.max(...results.map((result) => result.name.length));
  console.log(`\n${"budget".padEnd(width)}  ${"measured".padStart(10)}  ${"max".padStart(10)}`);
  for (const result of results.filter((r) => !r.informational)) {
    const max = budgets[result.name];
    if (max === undefined) {
      failures.push(`${result.name}: measured ${result.value} ${result.unit} but has no budget; add one to bench/budgets.json`);
      continue;
    }
    const over = result.value > max;
    // A count below its budget is a gain nothing protects yet.
    const exact = result.unit === "scans" || result.unit === "spawns";
    const note = over ? "  OVER" : exact && result.value < max ? "  (below budget: lower it to keep the gain)" : "";
    console.log(`${result.name.padEnd(width)}  ${String(result.value).padStart(10)}  ${String(max).padStart(10)}  ${result.unit}${note}`);
    if (over) failures.push(`${result.name}: ${result.value} ${result.unit} is over its budget of ${max}${result.detail ? `\n    ${result.detail}` : ""}`);
  }
  console.log(`\n${"informational (never gated)".padEnd(width)}  ${"measured".padStart(10)}`);
  for (const result of results.filter((r) => r.informational)) {
    console.log(`${result.name.padEnd(width)}  ${String(result.value).padStart(10)}  ${result.unit}`);
  }
  return failures;
}

const args = process.argv.slice(2);
const jsonOut = args[args.indexOf("--json") + 1];
const { $comment: _comment, ...budgets } = JSON.parse(readFileSync(join(import.meta.dir, "budgets.json"), "utf8")) as Record<string, number> & { $comment: string };

const home = assertBenchHome(mkdtempSync(join(tmpdir(), HOME_PREFIX)));
const started = performance.now();
let kept = false;
try {
  const results = bundleMeasurements();
  const fixture = makeRepository(home, LIVE_TASKS);
  const port = await freePort();
  const token = initHome(home, port);
  results.push(...seedAndMeasureDatabase(home, fixture.repo, fixture.base, fixture.worktrees));
  results.push(...(await daemonMeasurements(home, port, token, LIVE_TASKS)));
  if (args.includes("--json") && jsonOut) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
  const failures = check(results, budgets);
  console.log(`\nbench finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} budget(s) failed:\n  ${failures.join("\n  ")}\n\nIf the change is deliberate, raise the budget in bench/budgets.json and say why in the pull request.`);
    process.exitCode = 1;
  }
} catch (error) {
  kept = true;
  console.error(`bench failed; its home is kept at ${home}\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!kept) rmSync(home, { recursive: true, force: true });
}
