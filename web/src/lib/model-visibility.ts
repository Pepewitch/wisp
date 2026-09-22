import { modelOptionsFor } from "@/lib/model-choice"
import type { HarnessInfo } from "@/lib/types"

/**
 * Which models the picker offers, and which it keeps out of the way.
 *
 * opencode's probe reports ~150 ids and cursor's the whole catalog, so a
 * picker that shows every one of them is mostly scroll. The curation is a
 * DENYLIST kept in daemon settings (`hiddenModels`), for two reasons:
 *
 *  - a model a later probe discovers must appear on its own — an allowlist
 *    would silently swallow tomorrow's model;
 *  - the harness/model set belongs to the daemon's machine, so the curation
 *    should follow the daemon rather than one browser's localStorage.
 *
 * Hiding is a VIEW FILTER and nothing else. `wisp create --model <hidden>`
 * still runs, `/api/harnesses` still reports every id, and a task already
 * running on a hidden model keeps it — which is why every read here takes a
 * `keep` model that survives the filter no matter what.
 */
export type HiddenModels = Record<string, string[]>

export function isHidden(hidden: HiddenModels, harness: string, model: string): boolean {
  return hidden[harness]?.includes(model) ?? false
}

/**
 * The models this harness offers in the picker.
 *
 * `keep` is the selection the caller is currently showing. It is never
 * filtered out: a menu whose radio value is absent from its own options has no
 * checked row, and the trigger would name a model the list denies exists.
 */
export function visibleModelsFor(
  harness: HarnessInfo,
  hidden: HiddenModels,
  keep?: string | null,
): string[] {
  return modelOptionsFor(harness).filter(
    (model) => model === keep || !isHidden(hidden, harness.name, model),
  )
}

/** How many of this harness's offered models the curation keeps out. */
export function hiddenCountFor(harness: HarnessInfo, hidden: HiddenModels): number {
  const options = modelOptionsFor(harness)
  return options.length - visibleModelsFor(harness, hidden).length
}

/** Shown and offered totals across every harness, for the Settings row's count. */
export function modelTotals(
  harnesses: HarnessInfo[],
  hidden: HiddenModels,
): { shown: number; total: number } {
  let shown = 0
  let total = 0
  for (const harness of harnesses) {
    total += modelOptionsFor(harness).length
    shown += visibleModelsFor(harness, hidden).length
  }
  return { shown, total }
}

/** Every hidden model across every harness — what the picker's footer counts. */
export function hiddenTotal(harnesses: HarnessInfo[], hidden: HiddenModels): number {
  return harnesses.reduce((sum, harness) => sum + hiddenCountFor(harness, hidden), 0)
}

/**
 * A harness whose models are ALL hidden drops out of the picker entirely —
 * that is how a harness you never reach for is retired. It comes back the
 * moment one of its models is shown again, and the footer's count is what
 * says it is out there.
 */
export function pickerHarnesses(
  harnesses: HarnessInfo[],
  hidden: HiddenModels,
  keep?: { harness: string; model: string } | null,
): HarnessInfo[] {
  return harnesses.filter((harness) => {
    const keepModel = keep?.harness === harness.name ? keep.model : null
    // an unusable harness has no models to hide; it keeps its greyed-out row
    // with the reason, because "why can't I pick droid" is a real question
    if (modelOptionsFor(harness).length === 0) return true
    return visibleModelsFor(harness, hidden, keepModel).length > 0
  })
}

/** Normalized the way the daemon stores it: deduped, sorted, no empty lists. */
function withHarness(hidden: HiddenModels, harness: string, models: string[]): HiddenModels {
  const next = { ...hidden }
  const ids = [...new Set(models.filter((model) => model.trim() !== ""))].sort()
  if (ids.length === 0) delete next[harness]
  else next[harness] = ids
  return next
}

export function hideModel(hidden: HiddenModels, harness: string, model: string): HiddenModels {
  return withHarness(hidden, harness, [...(hidden[harness] ?? []), model])
}

export function showModel(hidden: HiddenModels, harness: string, model: string): HiddenModels {
  return withHarness(
    hidden,
    harness,
    (hidden[harness] ?? []).filter((id) => id !== model),
  )
}

export function toggleModel(hidden: HiddenModels, harness: string, model: string): HiddenModels {
  return isHidden(hidden, harness, model)
    ? showModel(hidden, harness, model)
    : hideModel(hidden, harness, model)
}

/**
 * Hide or show every model of one harness at once — the fast path, because
 * retiring opencode is one decision, not 150 of them.
 */
export function setHarnessHidden(
  hidden: HiddenModels,
  harness: HarnessInfo,
  hide: boolean,
): HiddenModels {
  return withHarness(hidden, harness.name, hide ? modelOptionsFor(harness) : [])
}
