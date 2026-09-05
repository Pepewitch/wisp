import type { HarnessInfo } from "@/lib/types"
import {
  readConnectionStorage,
  removeConnectionStorage,
  type ReadWriteStorage,
  type WritableStorage,
  writeConnectionStorage,
} from "@/lib/connection-storage"

/** Product order for the built-in harness picker; custom adapters follow in their configured order. */
const HARNESS_ORDER = new Map([
  ["claude", 0],
  ["codex", 1],
  ["cursor", 2],
  ["droid", 3],
])

export function orderHarnesses(harnesses: HarnessInfo[]): HarnessInfo[] {
  const fallback = HARNESS_ORDER.size
  return [...harnesses].sort(
    (a, b) =>
      (HARNESS_ORDER.get(a.name) ?? fallback) -
      (HARNESS_ORDER.get(b.name) ?? fallback)
  )
}

/**
 * A launchable selection. `model` is a plain string, never null: wisp policy is
 * an explicit model on every create, so a choice that cannot name one is not a
 * choice — it is an unusable harness, and the picker disables it.
 */
export interface ModelChoice {
  harness: string
  model: string
}

const PREFERRED_MODEL_KEY = "wisp_preferred_model"
const PREFERRED_MODEL_STORAGE_NAME = "preferred_model"

/** The connection-local model used to seed future create dialogs. */
export function loadPreferredModel(
  connectionId: string,
  storage?: ReadWriteStorage
): ModelChoice | null {
  try {
    const raw = readConnectionStorage(
      connectionId,
      PREFERRED_MODEL_STORAGE_NAME,
      PREFERRED_MODEL_KEY,
      storage
    )
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null
    const { harness, model } = parsed as Record<string, unknown>
    if (typeof harness !== "string" || harness.trim() === "") return null
    if (typeof model !== "string" || model.trim() === "") return null
    return { harness, model }
  } catch {
    return null
  }
}

/** Persist one preferred model, or clear it. Storage failure costs only this convenience. */
export function savePreferredModel(
  connectionId: string,
  choice: ModelChoice | null,
  storage?: WritableStorage
): void {
  if (choice) {
    writeConnectionStorage(
      connectionId,
      PREFERRED_MODEL_STORAGE_NAME,
      PREFERRED_MODEL_KEY,
      JSON.stringify(choice),
      storage
    )
  } else {
    removeConnectionStorage(
      connectionId,
      PREFERRED_MODEL_STORAGE_NAME,
      PREFERRED_MODEL_KEY,
      storage
    )
  }
}

/** The model a harness preselects: config default first, then the probed default. */
export function defaultModelFor(h: HarnessInfo): string | null {
  return h.defaults.model ?? h.models?.defaultModel ?? null
}

/**
 * Every model this harness can be asked for.
 *
 * The probed list, with the configured default prepended when the probe did not
 * return it — a configured default must never become unselectable because a
 * probe was stale. When the probe returned nothing at all but a default IS
 * configured, that default is the whole list: we know a model id, so the
 * harness is usable and there is nothing to type.
 */
export function modelOptionsFor(h: HarnessInfo): string[] {
  const list = h.models?.list ?? []
  const dflt = h.defaults.model
  if (list.length === 0) return dflt ? [dflt] : []
  if (dflt && !list.includes(dflt)) return [dflt, ...list]
  return list
}

/**
 * A harness we cannot name a single model for cannot be launched. That is a
 * property of THIS machine — a binary that is not installed, a probe that
 * failed or has not run — so the picker greys it out with the reason instead of
 * asking the user to guess a model id into a text box.
 */
export function isUsable(h: HarnessInfo): boolean {
  return modelOptionsFor(h).length > 0
}

/** Why a harness cannot be picked, in words a person can act on. */
export function unusableReason(h: HarnessInfo): string {
  if (h.modelsError) return h.modelsError
  if (h.models === null) return "not probed on this machine"
  return "no models reported"
}

/** The opening selection: an available preference, then the first harness this machine can actually run. */
export function initialChoice(
  harnesses: HarnessInfo[],
  preferred: ModelChoice | null = null
): ModelChoice | null {
  if (preferred) {
    const harness = harnesses.find((entry) => entry.name === preferred.harness)
    if (harness && modelOptionsFor(harness).includes(preferred.model))
      return preferred
  }
  const usable = harnesses.find(isUsable)
  if (!usable) return null
  const options = modelOptionsFor(usable)
  const dflt = defaultModelFor(usable)
  return {
    harness: usable.name,
    model: dflt && options.includes(dflt) ? dflt : options[0]!,
  }
}
