import { COMPACT_STRATEGIES, IMAGE_DELIVERY_STRATEGIES, probeCommands, type AdapterDef } from "../adapters";
import type { WispConfig } from "../config";
import type { CachedModels, ModelCacheEntry, ModelProbeCache } from "../model-probes";
import { undeliveredOutbox } from "../store";
import { json } from "./http";

/**
 * The model list the new-task picker is offered.
 *
 * A real probe ALWAYS wins. An adapter's curated `staticModels` fills in only
 * for a harness whose CLI enumerates none (claude — see AdapterDef.staticModels),
 * and is returned under the same shape as a probe so the UI keeps its "a model
 * is always PICKED, never typed" contract instead of dropping to free text.
 */
export function offeredModels(def: AdapterDef, cached: ModelCacheEntry): CachedModels | null {
  const probed = cached.models;
  if (probed && probed.list.length > 0) return probed;
  if (!def.staticModels || def.staticModels.length === 0) return probed;
  return {
    list: def.staticModels,
    // a real probe's default always wins; the adapter's declared default is
    // the static list's own (cursor: Grok 4.6 — owner-pinned, slice 9)
    defaultModel: probed?.defaultModel ?? def.defaultModel ?? null,
    probedAt: probed?.probedAt ?? new Date().toISOString(),
  };
}

/** GET /api/harnesses */
export function harnessesRoute(
  url: URL,
  cfg: WispConfig,
  adapters: Record<string, AdapterDef>,
  models: ModelProbeCache,
): Response {
  // the new-task form's harness picker: capability flags come from each
  // loaded adapter's argv templates, defaults from config harnessDefaults.
  // Probing is cached and async: this response never waits for a CLI.
  if (url.searchParams.get("refresh") === "1") void models.refresh();
  return json({
    harnesses: Object.entries(adapters).map(([name, def]) => ({
      name,
      hasModel: def.model !== undefined,
      hasEffort: def.effort !== undefined,
      // S3: paste is disabled-with-reason without one of the three mechanisms
      // (truthiness, not !== undefined: adapters.json null CLEARS a builtin's)
      hasImage: Boolean(def.image ?? def.imageInput ?? def.imageDelivery),
      hasLiveSteering: Boolean(def.liveInput),
      // A1c: delivery-by-path has a caveat argv delivery does not, and the
      // strategy owns that sentence — the composer only renders it
      ...(def.imageDelivery && IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]
        ? { imageNote: IMAGE_DELIVERY_STRATEGIES[def.imageDelivery]!.note }
        : {}),
      // the levels the harness itself accepts, so the picker offers instead
      // of asking for a guess; [] means this adapter declares none
      effortLevels: def.effortLevels ?? [],
      // A3: the out-of-turn reads this harness honestly offers (the palette's
      // Tier 2). [] = it has none, and the tier renders no group for it.
      probeCommands: probeCommands(def),
      // A5: how this harness compacts, if it does. "action" = the daemon runs
      // it out of band (recordsTurn tells the entry whether to say "runs a
      // turn" — codex does, droid doesn't); "prompt" = the harness's own
      // compact command rides an ordinary turn, so the palette prefills it
      // (claude). null = compaction is honestly absent.
      compact: def.compact
        ? { kind: "action" as const, recordsTurn: COMPACT_STRATEGIES[def.compact]?.recordsTurn ?? false }
        : def.compactPrompt
          ? { kind: "prompt" as const, prompt: def.compactPrompt }
          : null,
      defaults: cfg.harnessDefaults[name] ?? {},
      models: offeredModels(def, models.snapshot(name)),
      ...(models.snapshot(name).modelsError ? { modelsError: models.snapshot(name).modelsError } : {}),
    })),
  });
}

/**
 * GET /api/outbox. One line of body and no kin: the outbox has no other route,
 * so it rides along here rather than justifying a module of its own.
 */
export function outboxRoute(): Response {
  return json(undeliveredOutbox());
}
