/**
 * `wisp models` (P5c) — per configured adapter: the effective model for a new
 * task (explicit --model > config.json harnessDefaults > the harness's own
 * default), the harness's own default when the CLI reveals one, and the model
 * list the installed CLI exposes.
 *
 * Harness wire knowledge (HOW to ask each CLI) lives in adapters.ts's
 * MODEL_DISCOVERY named strategies; this module only composes their results
 * with config precedence and renders lines — the CLI command is one call.
 * Where a harness exposes nothing (or can't be probed), the report says so
 * out loud; nothing here invents or hardcodes a model id.
 */
import { discoverModels, type AdapterDef, type ModelDiscovery } from "./adapters";
import type { HarnessDefaults } from "./config";
import type { SpawnFn } from "./doctor";

/** One harness's probe + config state, ready for rendering. */
export interface HarnessModelInfo {
  name: string;
  def: AdapterDef;
  /** config.json harnessDefaults model for this harness; null = no config override */
  configModel: string | null;
  /** null when the probe itself failed — probeError says why */
  discovery: ModelDiscovery | null;
  probeError: string | null;
}

/**
 * Run every configured adapter's discovery. A strategy whose spawn throws
 * (binary not on PATH, …) becomes a probeError line for THAT harness, never a
 * crash of the whole report — same posture as doctor's per-harness checks.
 */
export async function probeModels(
  adapters: Record<string, AdapterDef>,
  harnessDefaults: Record<string, HarnessDefaults>,
  spawn: SpawnFn,
): Promise<HarnessModelInfo[]> {
  return Promise.all(
    Object.entries(adapters).map(async ([name, def]) => {
      let discovery: ModelDiscovery | null = null;
      let probeError: string | null = null;
      try {
        discovery = await discoverModels(def, spawn);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // the SpawnFn contract: throwing means the binary itself can't be spawned
        probeError = /ENOENT/.test(msg) ? `'${def.bin}' not found on PATH` : msg;
      }
      return { name, def, configModel: harnessDefaults[name]?.model ?? null, discovery, probeError };
    }),
  );
}

/**
 * The one-line-per-harness verdict: which model a new task gets, and WHY.
 * Config override beats harness default (P5b); the harness default is named
 * when the CLI exposed it, and its absence is named too.
 */
function effectiveLine(info: HarnessModelInfo): string {
  const { name, def, configModel, discovery, probeError } = info;
  const harnessDefault = discovery?.defaultModel ?? null;
  // detailLines prints the full probe error; the verdict line stays terse
  const whyNoDefault = probeError ? "unknown (probe failed)" : `not exposed by ${def.bin}`;
  if (configModel && harnessDefault && configModel !== harnessDefault) {
    return `${name}: effective ${configModel} (from config; harness default ${harnessDefault})`;
  }
  if (configModel && harnessDefault) {
    return `${name}: effective ${configModel} (from config; same as the harness default)`;
  }
  if (configModel) {
    return `${name}: effective ${configModel} (from config; harness default ${whyNoDefault})`;
  }
  if (harnessDefault) {
    return `${name}: effective ${harnessDefault} (harness default; no config override)`;
  }
  const reason = probeError ? `could not probe ${def.bin}` : `${def.bin} exposes no default`;
  return `${name}: effective <harness default> — ${reason}; no config override (pin one via config.json harnessDefaults or pass --model)`;
}

function detailLines(info: HarnessModelInfo): string[] {
  const { name, def, configModel, discovery, probeError } = info;
  const out: string[] = [];
  if (discovery?.defaultModel) out.push(`  harness default: ${discovery.defaultModel}`);
  if (configModel) {
    let line = `  config default: ${configModel} — new tasks get this unless --model is passed (config.json harnessDefaults)`;
    // the P5b boot warning, surfaced where a user goes to understand model
    // selection: a default recorded on tasks that never reaches the harness
    if (!def.model) {
      line += ` — WARNING: the '${name}' adapter has no model argv template, so it never reaches the harness`;
    }
    out.push(line);
  }
  if (probeError) {
    out.push(`  probe failed: ${probeError}`);
  } else if (discovery?.models?.length) {
    out.push(`  models (${discovery.models.length}): ${discovery.models.join(", ")}`);
  } else {
    out.push(`  model list not exposed by ${def.bin} — any id the CLI accepts works`);
  }
  for (const note of discovery?.notes ?? []) out.push(`  note: ${note}`);
  return out;
}

export function formatModelsReport(infos: HarnessModelInfo[]): string[] {
  const lines = ["precedence for new tasks: explicit --model > config.json harnessDefaults > the harness's own default"];
  for (const info of infos) {
    lines.push("", effectiveLine(info), ...detailLines(info));
  }
  return lines;
}

/** The `wisp models` command body: probe every configured adapter and render. */
export async function modelsReport(
  adapters: Record<string, AdapterDef>,
  harnessDefaults: Record<string, HarnessDefaults>,
  spawn: SpawnFn,
): Promise<string[]> {
  const lines = formatModelsReport(await probeModels(adapters, harnessDefaults, spawn));
  // config entries for harnesses wisp knows no adapter for would otherwise be
  // invisible here (they already warn at daemon boot — checkHarnessDefaults)
  const unknown = Object.keys(harnessDefaults).filter((h) => !adapters[h]);
  if (unknown.length > 0) {
    lines.push("", `harnessDefaults entries naming no known adapter (ignored): ${unknown.join(", ")}`);
  }
  return lines;
}
