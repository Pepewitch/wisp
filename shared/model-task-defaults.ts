/**
 * What a new task starts with on each model: a task brief, auto-fix and
 * auto-merge. The daemon stores them (settings' `modelTaskDefaults`), the
 * Models modal edits them, and the create composer seeds its switches from
 * them. A task is free to differ; these only decide where its switches start.
 *
 * Stored as OVERRIDES of the built-in defaults, so a model nobody touched
 * (including one a later probe discovers) starts with a brief and neither
 * autopilot switch, and the stored map stays small and comparable.
 */

export interface ModelTaskDefaults {
  brief: boolean;
  autoFix: boolean;
  autoMerge: boolean;
}

export const MODEL_TASK_DEFAULT_KEYS = ["brief", "autoFix", "autoMerge"] as const satisfies readonly (keyof ModelTaskDefaults)[];

export const BUILTIN_MODEL_TASK_DEFAULTS: Readonly<ModelTaskDefaults> = Object.freeze({
  brief: true,
  autoFix: false,
  autoMerge: false,
});

/** harness name -> model id -> the switches that differ from the built-in defaults */
export type ModelTaskDefaultsMap = Record<string, Record<string, Partial<ModelTaskDefaults>>>;

export function modelTaskDefaultsFor(
  all: ModelTaskDefaultsMap | undefined,
  harness: string,
  model: string,
): ModelTaskDefaults {
  return { ...BUILTIN_MODEL_TASK_DEFAULTS, ...all?.[harness]?.[model] };
}

/**
 * Drop every value equal to its built-in default, every model left with no
 * override and every harness left with no model, and order keys. Two equal
 * maps then serialize identically, which is what lets the settings route
 * no-op an idempotent PATCH.
 */
export function normalizeModelTaskDefaults(all: ModelTaskDefaultsMap): ModelTaskDefaultsMap {
  const out: ModelTaskDefaultsMap = {};
  for (const harness of Object.keys(all).sort()) {
    const models: Record<string, Partial<ModelTaskDefaults>> = {};
    for (const model of Object.keys(all[harness]!).sort()) {
      const entry: Partial<ModelTaskDefaults> = {};
      for (const key of MODEL_TASK_DEFAULT_KEYS) {
        const value = all[harness]![model]![key];
        if (value !== undefined && value !== BUILTIN_MODEL_TASK_DEFAULTS[key]) entry[key] = value;
      }
      if (Object.keys(entry).length > 0) models[model] = entry;
    }
    if (Object.keys(models).length > 0) out[harness] = models;
  }
  return out;
}

export function sameModelTaskDefaults(a: ModelTaskDefaultsMap, b: ModelTaskDefaultsMap): boolean {
  return JSON.stringify(normalizeModelTaskDefaults(a)) === JSON.stringify(normalizeModelTaskDefaults(b));
}

/** One switch of one model set, normalized the way the daemon stores it. */
export function setModelTaskDefault(
  all: ModelTaskDefaultsMap,
  harness: string,
  model: string,
  key: keyof ModelTaskDefaults,
  value: boolean,
): ModelTaskDefaultsMap {
  return normalizeModelTaskDefaults({
    ...all,
    [harness]: { ...all[harness], [model]: { ...all[harness]?.[model], [key]: value } },
  });
}
