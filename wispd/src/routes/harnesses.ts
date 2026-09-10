import { COMPACT_STRATEGIES, IMAGE_DELIVERY_STRATEGIES, offeredModels, probeCommands, type AdapterDef } from "../adapters";
import type { WispConfig } from "../config";
import type { CachedModels, ModelCacheEntry, ModelProbeCache } from "../model-probes";
import { undeliveredOutbox } from "../store";
import { json } from "./http";

/**
 * The model list the new-task picker is offered, in the cache's shape.
 *
 * The precedence itself lives in adapters/discovery.ts so `wisp models` uses
 * the same rule; this only carries `probedAt`, which the picker needs and the
 * CLI does not. Returning a curated list under the probe's shape keeps the
 * UI's "a model is always PICKED, never typed" contract instead of dropping to
 * free text.
 */
export function offeredCachedModels(def: AdapterDef, cached: ModelCacheEntry): CachedModels | null {
  const probed = cached.models;
  const offered = offeredModels(def, probed?.list ?? null, probed?.defaultModel ?? null);
  if (!offered) return probed;
  if (!offered.curated) return probed;
  return {
    list: offered.list,
    defaultModel: offered.defaultModel,
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
    // Daemon-level feature flags. A client newer than its daemon reads a
    // missing flag as false and hides the feature, instead of offering a
    // switch an older /send would silently ignore.
    features: { taskAgentSwitching: true, taskSearch: true },
    harnesses: Object.entries(adapters).map(([name, def]) => ({
      name,
      hasModel: def.model !== undefined,
      hasEffort: def.effort !== undefined,
      // S3: paste is disabled-with-reason without one of the three mechanisms
      // (truthiness, not !== undefined: adapters.json null CLEARS a builtin's)
      hasImage: Boolean(def.image ?? def.imageInput ?? def.imageDelivery),
      // A1d: what this harness can be handed at all. pdf/text/video are on the
      // list for every harness because they travel by PATH — that is a fact
      // about the prompt, not a channel a CLI has to declare — while images
      // still need one of the three image mechanisms. A client older than this
      // field reads it as absent and falls back to hasImage.
      attachmentKinds: [
        ...(def.image ?? def.imageInput ?? def.imageDelivery ? (["image"] as const) : []),
        "pdf",
        "text",
        "video",
      ],
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
      models: offeredCachedModels(def, models.snapshot(name)),
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
