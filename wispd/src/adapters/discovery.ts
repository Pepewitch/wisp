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

/** One model record from `opencode models --verbose`. */
export interface OpencodeCatalogEntry {
  providerID: string;
  id: string;
  capabilities?: Record<string, unknown>;
  variants?: Record<string, unknown>;
}

/**
 * Walk the model records out of `opencode models --verbose`, whose output is
 * an `id line` + pretty-printed JSON object per model. A brace-depth scan that
 * skips string contents, rather than a line split: the records span many lines
 * and the id lines sit between them.
 */
export function opencodeCatalog(text: string): OpencodeCatalogEntry[] {
  const out: OpencodeCatalogEntry[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (escaped) {
        escaped = false;
      } else if (inString) {
        if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) break; // truncated output: stop rather than rescan the tail
    try {
      const parsed: unknown = JSON.parse(text.slice(i, end + 1));
      if (isRecord(parsed) && typeof parsed.providerID === "string" && typeof parsed.id === "string") {
        out.push(parsed as unknown as OpencodeCatalogEntry);
      }
    } catch {
      // not a model record; the scan continues past it
    }
    i = end;
  }
  return out;
}

/**
 * Can this catalog entry NOT run a coding turn? An agent turn needs to call
 * tools and answer in text, and opencode's catalog states both per model.
 *
 * FAIL-OPEN, deliberately: only an explicit `false` rejects. Absent or
 * unrecognised metadata keeps the model, because the one thing worse than a
 * noisy picker is a picker that silently hides the model someone configured.
 * That matters most for CUSTOM providers — a hand-written `provider` block in
 * opencode.json may describe a model sparsely, and it must still be offered.
 *
 * What this removes on a real install (opencode 1.18.29): embedding models,
 * image and video generation, TTS and live-translate variants — 17 of 53
 * entries, every one of them `toolcall: false`, none of them merely missing
 * the field. It never removes a model for being unreachable: a local server
 * that is switched off right now is still a configured model, and hiding it
 * would break the ordinary "pick the model, then start the server" flow.
 */
export function positivelyNotAgentCapable(model: OpencodeCatalogEntry): boolean {
  const caps = model.capabilities;
  if (!isRecord(caps)) return false;
  const output = isRecord(caps.output) ? caps.output : {};
  return caps.toolcall === false || output.text === false;
}

export const MODEL_DISCOVERY: Record<string, ModelDiscoveryFn> = {
  /**
   * droid (reverified against 0.213.0): the default model is named on the
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
   * codex (reverified against 0.153.4 and its generated app-server schema): `codex
   * debug models` prints the model catalog as JSON. codex sorts it by
   * `priority`, keeps `visibility: "hide"` entries out of the picker, and its
   * default when -m is unset is the FIRST picker-visible model in priority
   * order, else the first entry (models-manager manager.rs
   * build_available_models + default_model_from_available; openai_models.rs
   * show_in_picker = visibility == "list"). Auth-mode filtering
   * (supported_in_api) is NOT replicated — the raw catalog is what the CLI
   * advertises. In 0.153.4 this makes picker-visible `gpt-6-astra` the
   * discovered default without a Wisp release or hardcoded model list.
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

  /**
   * opencode (verified against 1.18.29): `opencode models` prints one
   * `provider/model` id per line and nothing else — no header, no ANSI, no
   * decoration (all 53 lines matched on the probed install). The catalog is
   * the CONFIGURED providers' models, so it grows and shrinks with the user's
   * credentials rather than being a fixed product list; that is the honest
   * answer for "what can this install run" and the reason there is no
   * staticModels here.
   *
   * NO default is reported, and that is a real absence rather than a gap in
   * this parse: opencode names no default on any CLI surface (it resolves one
   * from config and the authenticated providers at run time). Returning null
   * lets the user's `harnessDefaults` decide, which is the correct precedence.
   */
  "opencode-models": async (def, spawn, signal) => {
    // --verbose prints the SAME `provider/model` id lines plus one JSON record
    // per model, so one spawn answers both halves and they cannot disagree.
    const res = await spawn([def.bin, "models", "--verbose"], signal);
    const ids = res.stdout
      .split("\n")
      .map((line) => line.trim())
      // the shape guard IS the allowlist: only provider/model ids survive, so
      // a future banner or warning line cannot become a model the picker offers
      .filter((line) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(line));
    if (ids.length === 0) {
      return {
        defaultModel: null,
        models: null,
        notes: [
          `'${def.bin} models --verbose' printed no provider/model ids (exit ${res.exitCode}) — the CLI may be unauthenticated, or its output shape may have changed`,
        ],
      };
    }
    const rejected = new Set(
      opencodeCatalog(res.stdout)
        .filter(positivelyNotAgentCapable)
        .map((model) => `${model.providerID}/${model.id}`),
    );
    const models = [...new Set(ids)].filter((id) => !rejected.has(id));
    const notes = [
      `list from '${def.bin} models --verbose' (the configured providers' catalog); opencode names no default model on any CLI surface`,
    ];
    if (rejected.size > 0) {
      notes.push(
        `${rejected.size} model(s) hidden: the catalog marks them as not tool-calling or not text-producing (embeddings, image/video/audio generation, TTS) — they cannot run a coding turn`,
      );
    }
    // Every id was rejected: that is far likelier to be a changed capability
    // shape than a catalog with no usable model in it, so serve the unfiltered
    // list rather than an empty picker.
    if (models.length === 0) {
      return {
        defaultModel: null,
        models: [...new Set(ids)],
        notes: [
          notes[0]!,
          `every model was marked not agent-capable — the capability shape has probably changed, so nothing was hidden`,
        ],
      };
    }
    return { defaultModel: null, models, notes };
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
