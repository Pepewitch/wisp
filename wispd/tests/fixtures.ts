import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read a captured-harness-output fixture. These are real CLI output, not
 * hand-written approximations — see tests/fixtures/README.md for the exact
 * commands and versions they came from.
 */
export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

/** One JSONL fixture line by index (0-based), for per-event formatter tests. */
export function fixtureLine(name: string, index: number): string {
  const lines = fixture(name).split("\n").filter((l) => l.trim());
  const line = lines[index];
  if (line === undefined) throw new Error(`${name} has no line ${index} (${lines.length} lines)`);
  return line;
}
