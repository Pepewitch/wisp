#!/usr/bin/env bun
/**
 * `bun run harness:snapshot` — the expensive question, answered cheaply: does
 * the CLI's drift touch anything Wisp actually asserts?
 *
 * Re-reads every `cost: "free"` surface from the installed CLI, rewrites the
 * committed facts, and prints a graded diff. `cost: "live"` surfaces are never
 * re-run — they are carried forward untouched and reported with their pin, so
 * a turn is spent only when the report says one is genuinely needed.
 *
 *   --check           write nothing; exit 1 if anything drifted (CI, agents)
 *   --harness <name>  scope to one builtin
 */
import { BUILTIN_ADAPTERS } from "../../src/adapters";
import { bunModelProbeSpawn } from "../../src/model-probes";
import { diffFacts, worstSeverity, type Change, type Severity } from "./diff";
import { loadFacts, loadAllFacts, writeFacts, type HarnessFacts, type Surface } from "./facts";
import { EXTRACTORS } from "./extract";
import { installedVersion } from "./upstream";

/** What the reader should do about each class, in the reader's own terms. */
const NEXT_ACTION: Record<Severity, string> = {
  breaking: "fix before the next release — turns fail or misclassify until you do",
  catalog: "cheap edit in src/adapters/builtins.ts (harness-sync.md §4)",
  capability: "optional — a new surface Wisp could adopt",
  cosmetic: "no action; recorded so the next diff stays quiet",
};

/**
 * Merge freshly extracted free surfaces over the committed ones, carrying live
 * surfaces forward verbatim. The new pin is the version we just read them from
 * — that, and only that, is what "verified against" means here.
 */
export function mergeSurfaces(
  previous: HarnessFacts,
  extracted: Record<string, Surface>,
  version: string | null,
): HarnessFacts {
  const surfaces: Record<string, Surface> = {};
  for (const [name, surface] of Object.entries(previous.surfaces)) {
    if (surface.cost === "live") surfaces[name] = surface;
  }
  for (const [name, surface] of Object.entries(extracted)) {
    surfaces[name] = { ...surface, verifiedAgainst: version };
  }
  return { harness: previous.harness, bin: previous.bin, surfaces };
}

export function renderChanges(
  harness: string,
  version: string | null,
  changes: Change[],
  firstCaptured: string[] = [],
): string[] {
  const out = [`${harness} — extracted from the installed CLI${version ? ` (${version})` : ""}`];
  if (firstCaptured.length > 0) {
    // a surface with nothing to compare against is a baseline, not a verdict;
    // saying "no change" here would claim a comparison that never happened
    out.push(`  first capture (no prior values to compare): ${firstCaptured.join(", ")}`);
  }
  if (changes.length === 0) {
    if (firstCaptured.length === 0) {
      out.push("  no change to any free surface — this CLI update is irrelevant to Wisp");
    }
    return out;
  }
  for (const change of changes) {
    const what = `${change.surface}.${change.key} ${change.direction}`;
    out.push(`  ${change.severity.toUpperCase().padEnd(11)}${what}: ${change.values.join(", ")}`);
    if (change.reason) out.push(`  ${" ".repeat(11)}↳ ${change.reason}`);
  }
  const worst = worstSeverity(changes)!;
  out.push(`  verdict: ${worst} — ${NEXT_ACTION[worst]}`);
  return out;
}

/** Live surfaces are never auto-run; say so, and say what a refresh would cost. */
export function renderLivePins(facts: HarnessFacts, installed: string | null): string[] {
  const live = Object.entries(facts.surfaces).filter(([, s]) => s.cost === "live");
  if (live.length === 0) return [];
  const out = ["  live surfaces (not re-read — each costs a turn):"];
  for (const [name, surface] of live.sort(([a], [b]) => a.localeCompare(b))) {
    const stale = surface.verifiedAgainst && installed && surface.verifiedAgainst !== installed;
    out.push(`    ${name.padEnd(12)}pinned ${surface.verifiedAgainst ?? "never"}${stale ? "  → stale" : ""}`);
  }
  return out;
}

async function snapshotOne(facts: HarnessFacts, write: boolean): Promise<{ lines: string[]; drifted: boolean }> {
  const def = BUILTIN_ADAPTERS[facts.harness];
  const extractor = EXTRACTORS[facts.harness];
  if (!def || !extractor) {
    return { lines: [`${facts.harness} — no builtin adapter or extractor; skipped`], drifted: false };
  }
  const installed = await installedVersion(facts.bin, bunModelProbeSpawn);
  if (installed.error) {
    return { lines: [`${facts.harness} — skipped: ${installed.error}`], drifted: false };
  }
  const binPath = Bun.which(facts.bin);
  const extracted = await extractor({ def, binPath, spawn: bunModelProbeSpawn });
  const next = mergeSurfaces(facts, extracted, installed.version);
  const changes = diffFacts(facts, next, def);
  const firstCaptured = Object.entries(next.surfaces)
    .filter(([name, s]) => s.cost === "free" && s.lists && !facts.surfaces[name]?.lists)
    .map(([name]) => name)
    .sort();
  const lines = [
    ...renderChanges(facts.harness, installed.version, changes, firstCaptured),
    ...renderLivePins(next, installed.version),
  ];
  if (write) writeFacts(next);
  return { lines, drifted: changes.length > 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = !args.includes("--check");
  const only = args.includes("--harness") ? args[args.indexOf("--harness") + 1] : null;

  const all = loadAllFacts();
  const selected = all.filter((f) => !only || f.harness === only);
  if (only && selected.length === 0) {
    console.error(`unknown harness '${only}' — known: ${all.map((f) => f.harness).join(", ")}`);
    process.exit(2);
  }

  let drifted = false;
  const blocks: string[][] = [];
  for (const facts of selected) {
    // re-read from disk so a partial earlier write cannot skew the diff
    const current = loadFacts(facts.harness);
    const result = await snapshotOne(current, write);
    drifted ||= result.drifted;
    blocks.push(result.lines);
  }

  console.log(blocks.map((b) => b.join("\n")).join("\n\n"));
  if (!write && drifted) {
    console.log("\n--check: committed facts are stale. Re-run without --check, then reconcile the adapters.");
    process.exit(1);
  }
}

if (import.meta.main) await main();
