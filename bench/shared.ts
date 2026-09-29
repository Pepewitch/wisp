import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

/** One number the bench reports. Informational ones are printed, never gated. */
export interface Measurement {
  name: string;
  value: number;
  unit: string;
  informational?: boolean;
  /** printed when the budget fails: the plan, or what spawned */
  detail?: string;
}

export const HOME_PREFIX = "wisp-bench-";

/**
 * The bench writes a database, logs and worktrees into its home, so it runs
 * only in a directory it created itself under the system temp root, never in
 * ~/.wisp or a developer's dev home.
 */
export function assertBenchHome(home: string | undefined): string {
  const root = realpathSync(tmpdir());
  const real = home ? realpathSync(home) : "";
  if (!real || dirname(real) !== root || !basename(real).startsWith(HOME_PREFIX)) {
    throw new Error(`refusing to run: WISP_HOME must be a ${HOME_PREFIX}* directory under ${root}, got ${JSON.stringify(home)}`);
  }
  return real;
}

// A fixed-seed generator, so every run seeds the same text and plans, counts
// and bytes compare across runs.
let seed = 42;
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const COMMON = "the a to of and in is it that for on with this be as are was file test code function error fix build run".split(" ");
const WORDS = [...COMMON, ...Array.from({ length: 2000 }, () => Math.floor(random() * 1e9).toString(36))];

/** About `bytes` of word-shaped text. */
export function text(bytes: number): string {
  const out: string[] = [];
  for (let size = 0; size < bytes;) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

/** Median wall time of five runs after one warm-up, in ms. */
export function median(fn: () => unknown): number {
  fn();
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[2]! * 10) / 10;
}
