/**
 * Splits the daemon suite into CI shards by measured duration.
 *
 * `bun test --shard` splits by file name, and the daemon suite's slow files
 * (process groups, kill grace, restarts) sort next to each other, so one shard
 * carried twice the others' time and set CI's wall clock. This assigns files
 * longest first to the least-loaded shard, from the per-file seconds recorded
 * in `wispd/tests/durations.json`. A file missing from the map (a new test)
 * counts as a median file, so it still runs, in exactly one shard.
 *
 *   bun scripts/test-shards.ts 3/6          # list shard 3's files
 *   bun scripts/test-shards.ts --run 3/6    # run them (what CI does)
 *   bun scripts/test-shards.ts --record junit.xml
 *
 * Refresh the map after a test file gets much slower or faster:
 *   bun run --cwd wispd test -- --reporter=junit --reporter-outfile=/tmp/wisp-junit.xml
 *   bun scripts/test-shards.ts --record /tmp/wisp-junit.xml
 * A partial report (one file's run) updates just those files.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WISPD = join(import.meta.dir, "..", "wispd");
const DURATIONS_PATH = join(WISPD, "tests", "durations.json");
const MIN_FILE_SECONDS = 0.1;
/** Bun's own test-file patterns, under the package's test root (wispd/bunfig.toml). */
const TEST_GLOB = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx}");

export function testFiles(): string[] {
  return [...TEST_GLOB.scanSync({ cwd: join(WISPD, "tests") })]
    .filter((file) => !file.split("/").includes("node_modules"))
    .map((file) => `tests/${file}`)
    .sort();
}

export function parseShard(spec: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`shard must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(spec)}`);
  return { index, count };
}

/**
 * Longest-processing-time assignment: deterministic for a given file list and
 * map, and within one file of optimal. Each shard's files run in name order,
 * as they did under `--shard`.
 */
export function assignShards(files: string[], seconds: Record<string, number>, count: number): string[][] {
  const known = files.map((file) => seconds[file]).filter((s): s is number => typeof s === "number").sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)]! : 1;
  // A floor, so the many files that finish in milliseconds spread out rather
  // than all tying at zero onto the one lightest shard.
  const cost = (file: string): number => Math.max(seconds[file] ?? fallback, MIN_FILE_SECONDS);
  const order = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const file of order) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.files.push(file);
    lightest.load += cost(file);
  }
  return shards.map((shard) => shard.files.sort());
}

/** Per-file seconds from a `bun test --reporter=junit` report: the sum of its test cases. */
export function parseJunit(xml: string): Record<string, number> {
  const seconds: Record<string, number> = {};
  for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const tag = match[0];
    const file = /\bfile="([^"]+)"/.exec(tag)?.[1];
    const time = Number(/\btime="([\d.]+)"/.exec(tag)?.[1]);
    if (file && Number.isFinite(time)) seconds[file] = (seconds[file] ?? 0) + time;
  }
  return seconds;
}

interface DurationsFile {
  $comment: string;
  seconds: Record<string, number>;
}

export function readDurations(): Record<string, number> {
  if (!existsSync(DURATIONS_PATH)) return {};
  return (JSON.parse(readFileSync(DURATIONS_PATH, "utf8")) as DurationsFile).seconds;
}

function record(report: string): void {
  const files = new Set(testFiles());
  const merged = { ...readDurations(), ...parseJunit(readFileSync(report, "utf8")) };
  const seconds = Object.fromEntries(
    Object.entries(merged)
      .filter(([file]) => files.has(file))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, s]) => [file, Math.round(s * 10) / 10]),
  );
  const body: DurationsFile = {
    $comment: "Per-file seconds for balancing CI's daemon shards. Written by `bun scripts/test-shards.ts --record <junit.xml>`; see that script. Only the proportions matter.",
    seconds,
  };
  writeFileSync(DURATIONS_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`recorded ${Object.keys(seconds).length} files in ${DURATIONS_PATH}`);
}

function shardFiles(spec: string): string[] {
  const { index, count } = parseShard(spec);
  const seconds = readDurations();
  const shards = assignShards(testFiles(), seconds, count);
  const mine = shards[index - 1]!;
  // An empty list would make `bun test` run the WHOLE suite in this shard.
  if (mine.length === 0) throw new Error(`shard ${spec} has no test files`);
  const load = (files: string[]): string => files.reduce((sum, file) => sum + (seconds[file] ?? 0), 0).toFixed(1);
  console.error(`shard ${spec}: ${mine.length} files, ~${load(mine)} s recorded (shards: ${shards.map(load).join(", ")} s)`);
  return mine;
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === "--record" && second) {
    record(second);
  } else if (first === "--run" && second) {
    // `./` makes each argument a path; a bare name is a substring filter.
    const files = shardFiles(second).map((file) => `./${file}`);
    const run = Bun.spawnSync([process.execPath, "test", ...files], { cwd: WISPD, stdio: ["inherit", "inherit", "inherit"] });
    process.exit(run.exitCode ?? 1);
  } else if (first && !second) {
    console.log(shardFiles(first).join("\n"));
  } else {
    console.error("usage: bun scripts/test-shards.ts [--run] <index>/<count> | --record <junit.xml>");
    process.exit(2);
  }
}
