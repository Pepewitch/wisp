/**
 * Harness contract facts — the machine-readable half of "what Wisp asserts
 * about each harness CLI".
 *
 * The rule this file exists to serve: **don't diff versions, diff contracts**.
 * A CLI can jump twenty releases and change nothing Wisp depends on, or bump a
 * patch and rename a usage key. A version number is only a cache key for
 * "should I re-look"; the answer lives in the surfaces below.
 *
 * Two properties make the rest of the tooling simple:
 *
 *  - **Per-surface pins.** Each surface carries its OWN `verifiedAgainst`,
 *    because that is how this repo already works: droid's liveInput records
 *    "reverified on 0.213.0 … steering was last live-probed on 0.205.0". A
 *    single pin per harness would erase exactly the information that keeps a
 *    refresh cheap.
 *  - **`cost`.** `free` surfaces are re-read from the installed CLI with no
 *    model tokens (help text, catalogs, rejection messages, binary strings).
 *    `live` surfaces need a real turn, so the tooling never re-runs them — it
 *    reports their pin and names the command to run when one is stale.
 *
 * Every surface is a uniform `lists` + `scalars` bag so one generic differ
 * covers all of them; a new surface needs no new diff code.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Whether re-verifying this surface costs model tokens. */
export type SurfaceCost = "free" | "live";

export interface Surface {
  cost: SurfaceCost;
  /** The harness version this surface was last verified against; null = never. */
  verifiedAgainst: string | null;
  /** Where the fact came from, in the harness's own terms. Prose, for humans. */
  source: string;
  /** Anything that qualifies the fact — reduced confidence, known caveats. */
  note?: string;
  /** Named sets of observed strings (model ids, flags, markers, …). */
  lists?: Record<string, string[]>;
  /** Named single observed values (a default model, …). */
  scalars?: Record<string, string | null>;
}

export interface HarnessFacts {
  harness: string;
  bin: string;
  surfaces: Record<string, Surface>;
}

export const FACTS_DIR = join(import.meta.dir, "../../tests/harness-facts");

/**
 * Canonical serialization. Deterministic on purpose: sorted list contents,
 * sorted keys at every level. A diff that reorders is a diff nobody reads, and
 * the whole point of committing these files is that `git diff` is the report.
 */
export function serializeFacts(facts: HarnessFacts): string {
  const surfaces: Record<string, unknown> = {};
  for (const name of Object.keys(facts.surfaces).sort()) {
    const s = facts.surfaces[name]!;
    const out: Record<string, unknown> = {
      cost: s.cost,
      verifiedAgainst: s.verifiedAgainst,
      source: s.source,
    };
    if (s.note !== undefined) out.note = s.note;
    if (s.lists) {
      const lists: Record<string, string[]> = {};
      for (const key of Object.keys(s.lists).sort()) lists[key] = [...s.lists[key]!].sort();
      out.lists = lists;
    }
    if (s.scalars) {
      const scalars: Record<string, string | null> = {};
      for (const key of Object.keys(s.scalars).sort()) scalars[key] = s.scalars[key]!;
      out.scalars = scalars;
    }
    surfaces[name] = out;
  }
  return `${JSON.stringify({ harness: facts.harness, bin: facts.bin, surfaces }, null, 2)}\n`;
}

function assertShape(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
}

/** Read one facts file, failing loudly on a shape the tooling cannot trust. */
export function parseFacts(raw: string, path: string): HarnessFacts {
  const data: unknown = JSON.parse(raw);
  assertShape(data, path);
  const { harness, bin, surfaces } = data;
  if (typeof harness !== "string" || typeof bin !== "string") {
    throw new Error(`${path}: 'harness' and 'bin' must be strings`);
  }
  assertShape(surfaces, `${path}: surfaces`);
  const parsed: Record<string, Surface> = {};
  for (const [name, value] of Object.entries(surfaces)) {
    assertShape(value, `${path}: surfaces.${name}`);
    const { cost, verifiedAgainst, source } = value;
    if (cost !== "free" && cost !== "live") {
      throw new Error(`${path}: surfaces.${name}.cost must be 'free' or 'live'`);
    }
    if (verifiedAgainst !== null && typeof verifiedAgainst !== "string") {
      throw new Error(`${path}: surfaces.${name}.verifiedAgainst must be a string or null`);
    }
    if (typeof source !== "string" || source.length === 0) {
      throw new Error(`${path}: surfaces.${name}.source must be a non-empty string`);
    }
    parsed[name] = {
      cost,
      verifiedAgainst,
      source,
      ...(typeof value.note === "string" ? { note: value.note } : {}),
      ...(value.lists ? { lists: value.lists as Record<string, string[]> } : {}),
      ...(value.scalars ? { scalars: value.scalars as Record<string, string | null> } : {}),
    };
  }
  return { harness, bin, surfaces: parsed };
}

export function factsPath(harness: string): string {
  return join(FACTS_DIR, `${harness}.json`);
}

export function loadFacts(harness: string): HarnessFacts {
  const path = factsPath(harness);
  return parseFacts(readFileSync(path, "utf8"), path);
}

export function loadAllFacts(): HarnessFacts[] {
  return readdirSync(FACTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadFacts(f.replace(/\.json$/, "")));
}

export function writeFacts(facts: HarnessFacts): void {
  writeFileSync(factsPath(facts.harness), serializeFacts(facts));
}
