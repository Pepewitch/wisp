import { isRecord } from "../validate";
import { buildArgv } from "./argv";
import type { AdapterDef, ModelDiscovery, ModelDiscoveryFn, ModelProbeSpawnFn } from "./types";

/**
 * Sentinel for droid's invalid-model probe. It is deliberately NOT a real
 * model id: droid validates the -m value before doing any work (fails
 * pre-flight — no session, no quota; see tests/fixtures/droid-unknown-model.stderr.txt),
 * and prints its model list in the rejection text.
 */
export const DROID_MODEL_PROBE_SENTINEL = "wisp-probe-not-a-model";

/**
 * Parse "Available built-in models:\n  a, b, c" blocks out of droid's
 * invalid-model error text. Every indented line following a header line is
 * list content; the list repeats when the error text does. Generic over the
 * header wording ("built-in", "custom", …) so a droid that also lists custom
 * models is read without a change.
 */
function parseAvailableModelBlocks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/available\b.*\bmodels:/i.test(lines[i]!)) continue;
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]!); j++) {
      for (const id of lines[j]!.split(",")) {
        const t = id.trim();
        if (t && !out.includes(t)) out.push(t);
      }
    }
  }
  return out;
}

export const MODEL_DISCOVERY: Record<string, ModelDiscoveryFn> = {
  /**
   * droid (verified against 0.202.0): the default model is named on the
   * -m/--model line of `droid exec --help` ("Model ID to use (default:
   * claude-opus-5)") — the help argv is the adapter's own exec argv plus
   * --help, so user overrides of exec still land on the right help page.
   * The model LIST exists on exactly one surface: the invalid-model error
   * ("Available built-in models: …" on stderr). The probe reuses the
   * adapter's own exec/model argv templates via buildArgv with the sentinel
   * above; a def without a model template is never probed (without -m the
   * probe would launch a REAL turn). If either text shape changes, this
   * returns nulls + a note instead of guessing.
   */
  "droid-models": async (def, spawn, signal) => {
    const notes: string[] = [];

    let defaultModel: string | null = null;
    const help = await spawn([def.bin, ...def.exec, "--help"], signal);
    for (const line of `${help.stdout}\n${help.stderr}`.split("\n")) {
      // key on the --model line specifically: other options carry their own
      // "(default: …)" (e.g. --output-format's "(default: \"text\")")
      const m = line.includes("--model") ? line.match(/\(default:\s*([^)\s]+)\)/) : null;
      if (m) {
        defaultModel = m[1]!;
        break;
      }
    }
    if (!defaultModel) notes.push(`'${def.bin} --help' named no default model — droid's help text may have changed`);

    let models: string[] | null = null;
    if (def.model) {
      const probe = await spawn(buildArgv(def, { prompt: ".", model: DROID_MODEL_PROBE_SENTINEL }), signal);
      const found = parseAvailableModelBlocks(`${probe.stdout}\n${probe.stderr}`).filter(
        (id) => id !== DROID_MODEL_PROBE_SENTINEL,
      );
      if (found.length > 0) {
        models = found;
      } else {
        notes.push(
          "the invalid-model probe printed no 'Available … models:' block — droid's error text may have changed",
        );
      }
    } else {
      notes.push("the adapter has no model argv template to probe with — the list can't be discovered");
    }
    notes.push(
      `default from '${def.bin} … --help'; list from droid's invalid-model error text (its only model-list surface)`,
    );
    return { defaultModel, models, notes };
  },

  /**
   * codex (verified against 0.149.0, plus upstream rust-v0.149.0 source): `codex
   * debug models` prints the model catalog as JSON. codex sorts it by
   * `priority`, keeps `visibility: "hide"` entries out of the picker, and its
   * default when -m is unset is the FIRST picker-visible model in priority
   * order, else the first entry (models-manager manager.rs
   * build_available_models + default_model_from_available; openai_models.rs
   * show_in_picker = visibility == "list"). Auth-mode filtering
   * (supported_in_api) is NOT replicated — the raw catalog is what the CLI
   * advertises, and every 0.149.0 catalog entry is api-supported anyway.
   */
  "codex-models": async (def, spawn, signal) => {
    const res = await spawn([def.bin, "debug", "models"], signal);
    const shape = (note: string): ModelDiscovery => ({ defaultModel: null, models: null, notes: [note] });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return shape(
        `'${def.bin} debug models' printed no JSON catalog (exit ${res.exitCode}) — this codex version may not expose one`,
      );
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return shape(`'${def.bin} debug models' printed no models array — the catalog shape may have changed`);
    }
    const entries = (parsed.models as unknown[])
      .filter(isRecord)
      .filter((m) => typeof m.slug === "string" && m.slug.length > 0)
      .map((m, i) => ({
        slug: m.slug as string,
        // a missing visibility field predates picker hiding — treat as listed;
        // codex's own rule is show_in_picker = (visibility == "list")
        listed: m.visibility === undefined ? true : m.visibility === "list",
        priority: typeof m.priority === "number" ? m.priority : 1_000_000 + i,
      }))
      .sort((a, b) => a.priority - b.priority);
    if (entries.length === 0) {
      return shape(`'${def.bin} debug models' catalog was empty — the catalog shape may have changed`);
    }
    const listed = entries.filter((e) => e.listed);
    const pool = listed.length > 0 ? listed : entries; // codex falls back to the first entry when nothing is picker-visible
    return {
      defaultModel: pool[0]!.slug,
      models: pool.map((e) => e.slug),
      notes: [
        `list + default from '${def.bin} debug models' (catalog by priority; codex's default is its first list-visible entry)`,
      ],
    };
  },
};

/**
 * Ask the installed CLI what models its harness supports, per the adapter's
 * named discovery strategy. No strategy = the harness exposes nothing. The
 * unknown-strategy throw is unreachable via config (validateAdapter rejects
 * unknown names at load); it fires only for defs built in code — loud beats
 * `wisp models` silently reporting "not exposed" for a typo'd strategy name.
 *
 * Async over the injected spawn: the daemon passes its Bun.spawn runner so
 * probes never block the event loop; `wisp models` passes doctor's sync
 * bunSpawn, which satisfies the same ModelProbeSpawnFn type. Either way this
 * registry is the ONE implementation — there is no inline twin to drift.
 */
export async function discoverModels(
  def: AdapterDef,
  spawn: ModelProbeSpawnFn,
  signal?: AbortSignal,
): Promise<ModelDiscovery> {
  if (!def.modelDiscovery) return { defaultModel: null, models: null, notes: [] };
  const strategy = MODEL_DISCOVERY[def.modelDiscovery];
  if (!strategy) {
    const known = Object.keys(MODEL_DISCOVERY).join(", ");
    throw new Error(`adapter modelDiscovery '${def.modelDiscovery}' is not a known strategy (known: ${known})`);
  }
  return strategy(def, spawn, signal);
}
