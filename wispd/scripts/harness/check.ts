#!/usr/bin/env bun
/**
 * `bun run harness:check` — the cheap question: is my local CLI current, and
 * is Wisp caught up to it?
 *
 * Offline by default; `--remote` adds the upstream "latest" column. Nothing
 * here spends model tokens and nothing writes a file. The companion command,
 * `harness:snapshot`, answers the expensive question — whether the drift
 * touches anything Wisp actually asserts.
 */
import { bunModelProbeSpawn } from "../../src/model-probes";
import { compareVersions } from "../../src/update";
import { loadAllFacts, type HarnessFacts, type SurfaceCost } from "./facts";
import {
  describeSource,
  installedVersion,
  latestVersion,
  UPSTREAM_SOURCES,
  type FetchFn,
  type InstalledVersion,
} from "./upstream";

/**
 * Ordering across the three version dialects in play. Returns null when the
 * two cannot be ordered — cursor ships date builds like `2026.09.02-c22c1a3`,
 * which semver rejects. Equality still answers the question that matters, and
 * an invented ordering would report drift that does not exist.
 */
export function compareHarnessVersions(left: string, right: string): number | null {
  try {
    return compareVersions(left, right);
  } catch {
    return left === right ? 0 : null;
  }
}

export type PinState = "current" | "behind" | "unpinned";

/**
 * A surface is `behind` whenever it was last verified against something other
 * than what is installed. When the two versions cannot be ordered — cursor's
 * date builds — inequality is still decisive: a pin taken on a different build
 * has not been re-verified on this one. Only a missing pin is `unpinned`.
 */
export function pinState(pin: string | null, installed: string | null): PinState {
  if (!pin) return "unpinned";
  if (!installed) return "behind";
  const order = compareHarnessVersions(pin, installed);
  if (order === null) return pin === installed ? "current" : "behind";
  return order < 0 ? "behind" : "current";
}

export interface SurfaceState {
  surface: string;
  cost: SurfaceCost;
  pin: string | null;
  state: PinState;
}

export interface CheckRow {
  harness: string;
  bin: string;
  installed: InstalledVersion;
  latest: { version: string | null; error: string | null } | null;
  surfaces: SurfaceState[];
}

export function surfaceStates(facts: HarnessFacts, installed: string | null): SurfaceState[] {
  return Object.entries(facts.surfaces)
    .map(([surface, s]) => ({ surface, cost: s.cost, pin: s.verifiedAgainst, state: pinState(s.verifiedAgainst, installed) }))
    .sort((a, b) => a.surface.localeCompare(b.surface));
}

function group(states: SurfaceState[], cost: SurfaceCost, state: PinState): string[] {
  return states.filter((s) => s.cost === cost && s.state === state).map((s) => s.surface);
}

/**
 * The verdict line. It names the next action rather than the state, so an
 * agent can act on the output without opening the refresh guide first.
 */
function verdict(row: CheckRow): string {
  if (row.installed.error) return `  verdict: skipped — ${row.installed.error}`;
  const behindFree = group(row.surfaces, "free", "behind");
  const behindLive = group(row.surfaces, "live", "behind");
  const newer = row.latest?.version && row.installed.version
    ? compareHarnessVersions(row.latest.version, row.installed.version)
    : null;
  const lines: string[] = [];
  if (newer !== null && newer > 0) {
    lines.push(`upgrade the CLI first (${row.installed.version} → ${row.latest!.version}), then re-run`);
  }
  const unpinnedFree = group(row.surfaces, "free", "unpinned");
  if (behindFree.length + unpinnedFree.length > 0) {
    const n = behindFree.length + unpinnedFree.length;
    lines.push(`run 'bun run harness:snapshot --harness ${row.harness}' — ${n} free surface(s) unverified`);
  }
  if (behindLive.length > 0) lines.push(`live surfaces need a turn each: ${behindLive.join(", ")} (harness-sync.md §5)`);
  if (lines.length === 0) return "  verdict: up to date — every pinned surface matches the installed CLI";
  return `  verdict: ${lines.join("; ")}`;
}

export function renderRow(row: CheckRow): string[] {
  const out: string[] = [];
  const installed = row.installed.version ?? `— (${row.installed.error})`;
  const latest = row.latest ? `   latest ${row.latest.version ?? `— (${row.latest.error})`}` : "";
  out.push(`${row.harness.padEnd(8)}installed ${installed}${latest}`);
  for (const cost of ["free", "live"] as SurfaceCost[]) {
    const current = group(row.surfaces, cost, "current");
    const behind = group(row.surfaces, cost, "behind");
    const unpinned = group(row.surfaces, cost, "unpinned");
    if (current.length + behind.length + unpinned.length === 0) continue;
    const parts: string[] = [];
    if (current.length > 0) parts.push(`current: ${current.join(", ")}`);
    if (behind.length > 0) parts.push(`BEHIND: ${behind.join(", ")}`);
    if (unpinned.length > 0) parts.push(`unpinned: ${unpinned.join(", ")}`);
    out.push(`  ${cost.padEnd(6)}${parts.join(" | ")}`);
  }
  out.push(verdict(row));
  return out;
}

export function renderReport(rows: CheckRow[]): string[] {
  const lines = [
    "harness contract pins vs the installed CLIs.",
    "'free' surfaces re-verify with no model tokens; 'live' ones cost a turn each.",
  ];
  for (const row of rows) lines.push("", ...renderRow(row));
  return lines;
}

/** True when any installed harness has a surface pinned behind it. */
export function hasDrift(rows: CheckRow[]): boolean {
  return rows.some((row) => !row.installed.error && row.surfaces.some((s) => s.state === "behind"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const remote = args.includes("--remote");
  const strict = args.includes("--strict");
  const only = args.includes("--harness") ? args[args.indexOf("--harness") + 1] : null;

  const allFacts = loadAllFacts().filter((f) => !only || f.harness === only);
  if (only && allFacts.length === 0) {
    console.error(`unknown harness '${only}' — known: ${loadAllFacts().map((f) => f.harness).join(", ")}`);
    process.exit(2);
  }

  const rows: CheckRow[] = [];
  for (const facts of allFacts) {
    const installed = await installedVersion(facts.bin, bunModelProbeSpawn);
    const source = UPSTREAM_SOURCES[facts.harness];
    const latest = remote && source ? await latestVersion(source, fetch as FetchFn) : null;
    rows.push({
      harness: facts.harness,
      bin: facts.bin,
      installed,
      latest,
      surfaces: surfaceStates(facts, installed.version),
    });
  }

  console.log(renderReport(rows).join("\n"));
  if (remote) {
    console.log("");
    for (const facts of allFacts) {
      const source = UPSTREAM_SOURCES[facts.harness];
      if (source) console.log(`upstream source ${facts.harness}: ${describeSource(source)}`);
    }
  }
  if (strict && hasDrift(rows)) process.exit(1);
}

if (import.meta.main) await main();
