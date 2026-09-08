/**
 * The zero-token fact extractors — one per builtin.
 *
 * Every source here is a surface `harness-sync.md` §2 already names as manual
 * evidence: `<bin> --help`, a native catalog subcommand, an invalid-value
 * rejection message, and the shipped binary's own strings. Nothing is read
 * from release notes, documentation, or memory; nothing spends model tokens.
 *
 * **Allowlist, never redaction.** Each extractor emits only named fact keys —
 * model ids, effort values, flag tokens, marker presence. Help text is never
 * copied verbatim and a catalog is never dumped: `codex debug models` alone is
 * 375 KB of prompts and account prose. Wisp's repository is public, and a
 * redactor that has to recognise a secret is a redactor that will one day miss
 * one. An allowlist cannot leak what it never reads.
 */
import type { AdapterDef, ModelProbeSpawnFn } from "../../src/adapters";
import { buildArgv, discoverModels, DROID_MODEL_PROBE_SENTINEL } from "../../src/adapters";
import type { Surface } from "./facts";

/** Deliberately not a real effort level; every harness rejects it pre-flight. */
export const EFFORT_PROBE_SENTINEL = "wisp-probe-not-an-effort";

export interface ExtractCtx {
  def: AdapterDef;
  /** Resolved path to the installed binary; markers are read out of it. */
  binPath: string | null;
  spawn: ModelProbeSpawnFn;
}

export type Extractor = (ctx: ExtractCtx) => Promise<Record<string, Surface>>;

/**
 * Flag tokens from help output. The regex IS the allowlist: only `-x` and
 * `--long-flag` shapes survive, so a `(default: /Users/…)` in the help text
 * can never reach a committed file.
 */
export function flagsFromHelp(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*|-[a-zA-Z])(?![\w-])/g)) {
    found.add(match[1]!);
  }
  return [...found].sort();
}

/** "Allowed values: none, low, high" / "Expected 'a' | 'b'" → the values. */
export function effortValuesFromRejection(text: string): string[] {
  const line = text.split("\n").find((l) => /allowed values:/i.test(l));
  if (!line) return [];
  const after = line.slice(line.toLowerCase().indexOf("allowed values:") + "allowed values:".length);
  return after
    .split(",")
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
    .filter((v) => /^[a-z][a-z0-9_-]*$/i.test(v))
    .sort();
}

/**
 * Does this phrase still exist in the shipped binary? A fixed, case-insensitive
 * `grep -a` over the executable, one spawn per phrase — cheap (~0.5s on a
 * 270 MB binary) and, unlike reading the file into memory, bounded.
 *
 * This is a genuine observation about the CLI, not a restatement of the
 * adapter: a limit marker the binary can no longer emit is a marker that will
 * never fire, and a renamed one silently stops classifying quota failures.
 */
async function markersPresent(ctx: ExtractCtx, phrases: string[]): Promise<{ present: string[]; missing: string[] }> {
  const present: string[] = [];
  const missing: string[] = [];
  for (const phrase of phrases) {
    if (!ctx.binPath) {
      missing.push(phrase);
      continue;
    }
    const res = await ctx.spawn(["grep", "-aiqF", "--", phrase, ctx.binPath]);
    (res.exitCode === 0 ? present : missing).push(phrase);
  }
  return { present: present.sort(), missing: missing.sort() };
}

/** The marker-presence surface, or nothing when the adapter declares no markers. */
async function markerSurface(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  const declared = [...(ctx.def.limitMarkers ?? []), ...(ctx.def.transientMarkers ?? [])];
  if (declared.length === 0) return {};
  const { present, missing } = await markersPresent(ctx, declared);
  return {
    markerPresence: {
      cost: "free",
      verifiedAgainst: null,
      source: `case-insensitive fixed-string search of the installed ${ctx.def.bin} binary`,
      note: "'missing' markers cannot fire: the phrase no longer appears in the shipped CLI",
      lists: { present, missing },
    },
  };
}

/** `<bin> <exec…> --help`, so an exec override still lands on the right page. */
async function helpFlags(ctx: ExtractCtx, argv: string[]): Promise<Surface> {
  const res = await ctx.spawn(argv);
  return {
    cost: "free",
    verifiedAgainst: null,
    source: `flag tokens parsed out of '${argv.join(" ")}'`,
    lists: { values: flagsFromHelp(`${res.stdout}\n${res.stderr}`) },
  };
}

/** Reuses the adapter's own MODEL_DISCOVERY strategy — one probe, both facts. */
async function discoveredModels(ctx: ExtractCtx, source: string): Promise<Surface> {
  const discovery = await discoverModels(ctx.def, ctx.spawn);
  return {
    cost: "free",
    verifiedAgainst: null,
    source,
    lists: { ids: discovery.models ?? [] },
    scalars: { default: discovery.defaultModel },
  };
}

/** Effort values read off the harness's own rejection of an invalid level. */
async function rejectedEffort(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  if (!ctx.def.effort) return {};
  const argv = buildArgv(ctx.def, { prompt: ".", effort: EFFORT_PROBE_SENTINEL });
  const res = await ctx.spawn(argv);
  const values = effortValuesFromRejection(`${res.stdout}\n${res.stderr}`);
  if (values.length === 0) return {};
  return {
    effortLevels: {
      cost: "free",
      verifiedAgainst: null,
      source: `${ctx.def.bin}'s own rejection of an invalid reasoning effort`,
      lists: { observed: values },
    },
  };
}

/**
 * codex's effort enum is per-model, not global: each catalog entry carries
 * `supported_reasoning_levels`. The union is what the picker may legitimately
 * offer, so that is what gets recorded.
 */
async function codexEffort(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  const res = await ctx.spawn([ctx.def.bin, "debug", "models"]);
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {};
  }
  const values = new Set<string>();
  for (const model of parsed?.models ?? []) {
    for (const level of model?.supported_reasoning_levels ?? []) {
      const effort = typeof level === "string" ? level : level?.effort;
      if (typeof effort === "string" && /^[a-z]+$/.test(effort)) values.add(effort);
    }
  }
  if (values.size === 0) return {};
  return {
    effortLevels: {
      cost: "free",
      verifiedAgainst: null,
      source: "union of supported_reasoning_levels across 'codex debug models'",
      note: "codex's effort enum is per-model; this union is what the picker may offer",
      lists: { observed: [...values].sort() },
    },
  };
}

/**
 * claude's effort values come off its `--help` line, NOT off a rejection.
 * Probing with an invalid `--effort` would be a gamble: if a future claude
 * accepted the value instead of failing pre-flight, the probe would start a
 * real turn and spend tokens. Reading the help text cannot.
 */
async function claudeEffort(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  const res = await ctx.spawn([ctx.def.bin, "--help"]);
  const text = `${res.stdout}\n${res.stderr}`;
  const match = /--effort <level>[^\n]*\n?[^\n(]*\(([^)]*)\)/.exec(text);
  const values = (match?.[1] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^[a-z][a-z0-9_-]*$/i.test(v))
    .sort();
  if (values.length === 0) return {};
  return {
    effortLevels: {
      cost: "free",
      verifiedAgainst: null,
      source: "the '--effort <level>' line of 'claude --help'",
      lists: { observed: values },
    },
  };
}

/** claude enumerates no models; its ids are read out of the shipped binary. */
async function claudeModels(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  if (!ctx.binPath) return {};
  const pattern = "claude-(fable|opus|sonnet|haiku)-[0-9a-z.-]+";
  const res = await ctx.spawn(["grep", "-aoE", pattern, ctx.binPath]);
  const ids = [...new Set(res.stdout.split("\n").map((l) => l.trim()).filter(Boolean))].sort();
  if (ids.length === 0) return {};
  return {
    models: {
      cost: "free",
      verifiedAgainst: null,
      source: `model ids matching /${pattern}/ in the installed claude binary`,
      note:
        "an unfiltered binary scan: it includes legacy, dated and vendor-suffixed ids the " +
        "picker never offers. Sound for proving a pinned id still exists; NOT a list to add from.",
      lists: { ids },
      scalars: { default: null },
    },
  };
}

/** `cursor-agent models` prints "<id> - <display name>" once authenticated. */
async function cursorModels(ctx: ExtractCtx): Promise<Record<string, Surface>> {
  const res = await ctx.spawn([ctx.def.bin, "models"]);
  const ids = res.stdout
    .split("\n")
    .map((line) => /^([a-z0-9][a-z0-9.-]*) - \S/i.exec(line.trim())?.[1])
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return {};
  return {
    models: {
      cost: "free",
      verifiedAgainst: null,
      source: "'cursor-agent models' (requires an authenticated CLI)",
      note: "cursor's shipped list is an owner-curated subset of this catalog, by design",
      lists: { ids: [...new Set(ids)].sort() },
      scalars: { default: null },
    },
  };
}

export const EXTRACTORS: Record<string, Extractor> = {
  droid: async (ctx) => ({
    models: await discoveredModels(ctx, "'droid exec --help' default plus droid's invalid-model error text"),
    ...(await rejectedEffort(ctx)),
    flags: await helpFlags(ctx, [ctx.def.bin, ...ctx.def.exec, "--help"]),
    ...(await markerSurface(ctx)),
  }),

  codex: async (ctx) => ({
    models: await discoveredModels(ctx, "'codex debug models' catalog, in codex's own priority order"),
    ...(await codexEffort(ctx)),
    flags: await helpFlags(ctx, [ctx.def.bin, ...ctx.def.exec, "--help"]),
    ...(await markerSurface(ctx)),
  }),

  claude: async (ctx) => ({
    ...(await claudeModels(ctx)),
    ...(await claudeEffort(ctx)),
    flags: await helpFlags(ctx, [ctx.def.bin, "--help"]),
    ...(await markerSurface(ctx)),
  }),

  cursor: async (ctx) => ({
    ...(await cursorModels(ctx)),
    flags: await helpFlags(ctx, [ctx.def.bin, "--help"]),
    ...(await markerSurface(ctx)),
  }),
};

/** Exported for the droid extractor's tests; keeps the sentinel in one place. */
export { DROID_MODEL_PROBE_SENTINEL };
