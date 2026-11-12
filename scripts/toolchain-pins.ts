// The Bun version is a release input, so it gets the same treatment as the
// release version: one source of truth, every repeat checked against it.
//
// This exists because of a real failure. The repository pinned Bun 1.4.2 in 21
// places while a maintainer's machine ran 1.4.4, and `release:check` answered
// with three unrelated test failures — a stale-schema error from a newer
// SQLite and an unhandled stream 'error' event — in code the release had not
// touched. The gate was right that something was wrong and useless about what,
// which cost far more than the mismatch did. Two rules come out of that:
//
//   1. Every pin agrees with `package.json`'s `packageManager`. Checked in CI,
//      where a half-applied bump is cheap to catch.
//   2. A release is validated on the pinned Bun, not on whatever the operator
//      happens to have. Checked by `release:check`, before any slow gate runs,
//      so the answer is one line instead of a test log.
//
// Workflow pins are DISCOVERED rather than listed: a workflow added later is
// covered without touching this file, and the count assertion below still
// refuses a file whose pin line was renamed away.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `packageManager` here is the version every other site must match. */
export const TOOLCHAIN_SOURCE = "package.json";
const WORKFLOW_DIR = join(".github", "workflows");
/** `packageManager: "bun@1.4.4"` in any workspace manifest. */
const PACKAGE_MANAGER = /"packageManager":\s*"bun@([^"]+)"/g;
/** `bun-version: 1.4.4` as setup-bun takes it. */
const WORKFLOW_PIN = /^\s*bun-version:\s*(\S+)\s*$/gm;
/** The version CONTRIBUTING.md tells a new contributor to install. */
const CONTRIBUTING_PIN = /\*\*Bun ([0-9]+\.[0-9]+\.[0-9]+)\*\*/g;

/** Manifests that repeat the pin, beyond the source itself. */
const MANIFEST_SITES = ["wispd/package.json", "web/package.json"] as const;

export interface PinReading {
  file: string;
  versions: string[];
}

function readPins(source: string, pattern: RegExp, file: string): PinReading {
  const versions = [...source.matchAll(pattern)].map((match) => match[1]!);
  return { file, versions };
}

/** The pinned Bun version, from the one place that owns it. */
export function pinnedBun(root: string): string {
  const source = readFileSync(join(root, TOOLCHAIN_SOURCE), "utf8");
  const found = readPins(source, PACKAGE_MANAGER, TOOLCHAIN_SOURCE).versions;
  if (found.length !== 1) {
    throw new Error(
      `${TOOLCHAIN_SOURCE} must carry exactly one packageManager bun pin, found ${found.length}`,
    );
  }
  return found[0]!;
}

/** Every site that repeats the pin, source included. */
export function readToolchainSites(root: string): PinReading[] {
  const readings: PinReading[] = [
    readPins(readFileSync(join(root, TOOLCHAIN_SOURCE), "utf8"), PACKAGE_MANAGER, TOOLCHAIN_SOURCE),
  ];
  for (const file of MANIFEST_SITES) {
    readings.push(readPins(readFileSync(join(root, file), "utf8"), PACKAGE_MANAGER, file));
  }
  readings.push(
    readPins(readFileSync(join(root, "CONTRIBUTING.md"), "utf8"), CONTRIBUTING_PIN, "CONTRIBUTING.md"),
  );
  const dir = join(root, WORKFLOW_DIR);
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    const file = join(WORKFLOW_DIR, name);
    const reading = readPins(readFileSync(join(root, file), "utf8"), WORKFLOW_PIN, file);
    // A workflow that installs no Bun is not a site; one that does must agree.
    if (reading.versions.length > 0) readings.push(reading);
  }
  return readings;
}

export interface ToolchainCheck {
  version: string;
  sites: number;
  values: number;
}

/** Throws unless every pin agrees with `package.json`'s packageManager. */
export function checkToolchainPins(root: string): ToolchainCheck {
  const version = pinnedBun(root);
  const readings = readToolchainSites(root);
  const empty = readings.filter((reading) => reading.versions.length === 0);
  if (empty.length > 0) {
    throw new Error(
      `no bun pin found in ${empty.map((r) => r.file).join(", ")} — its pin line was renamed or removed, ` +
        "so nothing was being checked",
    );
  }
  const disagreeing = readings.filter((reading) => reading.versions.some((value) => value !== version));
  if (disagreeing.length > 0) {
    const detail = disagreeing
      .map((reading) => `${reading.file} -> ${JSON.stringify([...new Set(reading.versions)])}`)
      .join("; ");
    throw new Error(`bun pins disagree with ${TOOLCHAIN_SOURCE} (${version}): ${detail}`);
  }
  return {
    version,
    sites: readings.length,
    values: readings.reduce((total, reading) => total + reading.versions.length, 0),
  };
}

/**
 * Throws unless the Bun running this process is the pinned one.
 *
 * Release-gate only, and deliberately exact: a patch difference is what
 * produced the failure in this file's header. The message names the fix rather
 * than leaving an operator to guess which direction to move.
 */
export function checkRunningBun(root: string, running: string = Bun.version): void {
  const pinned = pinnedBun(root);
  if (running === pinned) return;
  throw new Error(
    `this Bun is ${running}, the repository pins ${pinned} (${TOOLCHAIN_SOURCE} packageManager). ` +
      `CI validates every release on ${pinned}, so a gate run here would not be evidence about the ` +
      `release. Install it with \`bun upgrade --to ${pinned}\`, or, if ${running} is the version this ` +
      "project should move to, bump the pin in its own change first (`bun run toolchain:check` lists every site).",
  );
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  try {
    const { version, sites, values } = checkToolchainPins(root);
    console.log(`bun ${version} agrees across ${sites} pin sites (${values} occurrences)`);
    if (Bun.version !== version) {
      console.warn(`warning: this Bun is ${Bun.version}; \`bun run release:check\` requires the pinned ${version}`);
    }
  } catch (error) {
    console.error(`toolchain-pins: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
