import {
  MODEL_TASK_DEFAULT_KEYS,
  normalizeModelTaskDefaults,
  type ModelTaskDefaults,
  type ModelTaskDefaultsMap,
} from "../../shared/model-task-defaults";
import { isRecord, typeName } from "./validate";

/**
 * Shape-check and normalize (shared/model-task-defaults.ts). A switch this
 * build does not know is dropped rather than refused, so a config written by a
 * newer Wisp with a fourth switch still boots; a wrong-typed known switch is
 * refused, like any other malformed setting. Harness and model names are never
 * checked against what is installed, for the reason hiddenModels gives.
 */
export function validateModelTaskDefaults(raw: unknown, label: string): ModelTaskDefaultsMap {
  const shape = "an object mapping harness names to objects of model ids";
  if (!isRecord(raw)) throw new Error(`${label} must be ${shape}, got ${typeName(raw)}`);
  const out: ModelTaskDefaultsMap = {};
  for (const [harness, models] of Object.entries(raw)) {
    if (!isRecord(models)) {
      throw new Error(`${label}['${harness}'] must be an object mapping model ids to defaults, got ${typeName(models)}`);
    }
    const byModel: Record<string, Partial<ModelTaskDefaults>> = {};
    for (const [model, entry] of Object.entries(models)) {
      const where = `${label}['${harness}']['${model}']`;
      if (!isRecord(entry)) throw new Error(`${where} must be an object of booleans, got ${typeName(entry)}`);
      const defaults: Partial<ModelTaskDefaults> = {};
      for (const key of MODEL_TASK_DEFAULT_KEYS) {
        const value = entry[key];
        if (value === undefined) continue;
        if (typeof value !== "boolean") throw new Error(`${where}.${key} must be a boolean, got ${typeName(value)}`);
        defaults[key] = value;
      }
      const id = model.trim();
      if (id !== "") byModel[id] = defaults;
    }
    out[harness] = byModel;
  }
  return normalizeModelTaskDefaults(out);
}
