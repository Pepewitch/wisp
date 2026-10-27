import type { HarnessInfo } from "@/lib/types"
import {
  connectionStorageKey,
  readConnectionStorage,
  removeConnectionStorage,
  type ReadWriteStorage,
  writeConnectionStorage,
} from "@/lib/connection-storage"

/**
 * Effort options, without inventing any.
 *
 * The levels come from the DAEMON (`HarnessInfo.effortLevels`), which reads
 * them off each CLI — droid prints its allowed values when handed a bad one,
 * claude documents them in `--help`, codex's API names them in its rejection.
 * The three lists genuinely differ, so this file still never guesses: an
 * adapter that declares nothing falls back to what has demonstrably worked on
 * THIS machine (the configured default, plus anything submitted before).
 *
 * That fallback is why a locally-used level is never dropped even when the
 * declared list is stale — a value that ran once stays offered.
 */
const KEY = "wisp_effort_recents"
const STORAGE_NAME = "effort_recents"
const MAX_PER_HARNESS = 6

type Recents = Record<string, string[]>

function read(connectionId: string, storage?: ReadWriteStorage): Recents {
  try {
    const raw = readConnectionStorage(connectionId, STORAGE_NAME, KEY, storage)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    // hand-editable storage is untrusted: keep only string[] entries
    const out: Recents = {}
    for (const [harness, list] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (Array.isArray(list))
        out[harness] = list.filter(
          (v): v is string => typeof v === "string" && v !== ""
        )
    }
    return out
  } catch {
    return {}
  }
}

/** Levels used before on this connection, newest first. */
export function recentEfforts(
  connectionId: string,
  harness: string,
  storage?: ReadWriteStorage
): string[] {
  return read(connectionId, storage)[harness] ?? []
}

/** Remember a level the user actually submitted, newest first, capped. */
export function rememberEffort(
  connectionId: string,
  harness: string,
  effort: string,
  storage?: ReadWriteStorage
): void {
  const value = effort.trim()
  if (!value) return
  const all = read(connectionId, storage)
  const next = [
    value,
    ...(all[harness] ?? []).filter((v) => v !== value),
  ].slice(0, MAX_PER_HARNESS)
  writeConnectionStorage(
    connectionId,
    STORAGE_NAME,
    KEY,
    JSON.stringify({ ...all, [harness]: next }),
    storage
  )
}

/**
 * What the effort menu shows: the harness's own levels in the order it names
 * them (low→max reads as a ladder, so preserve it), then anything used here
 * that the harness did not declare — a stale list must never hide a level that
 * actually works. Never empty when either source has something, and never
 * invented when both are empty.
 */
export function effortOptions(
  connectionId: string,
  h: HarnessInfo,
  storage?: ReadWriteStorage
): string[] {
  const declared = h.effortLevels ?? []
  const local = [
    h.defaults.reasoningEffort,
    ...recentEfforts(connectionId, h.name, storage),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of [...declared, ...local]) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * The starred effort per harness + model, seeding future create dialogs the
 * way the model star does. One level per pair: the same level means different
 * things on another harness or model, so a star never spreads.
 */
const PREFERRED_STORAGE_NAME = "preferred_effort"

export type PreferredEfforts = Record<string, string>

// a NUL cannot occur in a harness name or a model id
const pairKey = (harness: string, model: string) => `${harness}\u0000${model}`

export function loadPreferredEfforts(
  connectionId: string,
  storage?: ReadWriteStorage
): PreferredEfforts {
  try {
    // new with this key, so there is no pre-connection value to adopt
    const raw = readConnectionStorage(
      connectionId,
      PREFERRED_STORAGE_NAME,
      null,
      storage
    )
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    // hand-editable storage is untrusted: keep only "harness\0model" → level
    const out: PreferredEfforts = {}
    for (const [pair, level] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      const [harness, model, ...rest] = pair.split("\u0000")
      if (!harness || !model || rest.length > 0) continue
      if (typeof level === "string" && level.trim() !== "") out[pair] = level
    }
    return out
  } catch {
    return {}
  }
}

export function preferredEffortFor(
  preferred: PreferredEfforts,
  harness: string,
  model: string
): string | null {
  return preferred[pairKey(harness, model)] ?? null
}

/**
 * Star `level` for one pair, or clear the pair's star with `null`; returns the
 * stored map. The map is re-read here rather than taken from the caller: another
 * composer or tab may have starred other pairs since this one loaded.
 */
export function savePreferredEffort(
  connectionId: string,
  harness: string,
  model: string,
  level: string | null,
  storage?: ReadWriteStorage
): PreferredEfforts {
  const next = loadPreferredEfforts(connectionId, storage)
  if (level) next[pairKey(harness, model)] = level
  else delete next[pairKey(harness, model)]
  if (Object.keys(next).length > 0) {
    writeConnectionStorage(
      connectionId,
      PREFERRED_STORAGE_NAME,
      null,
      JSON.stringify(next),
      storage
    )
  } else {
    removeConnectionStorage(connectionId, PREFERRED_STORAGE_NAME, null, storage)
  }
  return next
}

/** The storage key a `storage` event names when another tab changes the stars. */
export const preferredEffortsStorageKey = (connectionId: string) =>
  connectionStorageKey(connectionId, PREFERRED_STORAGE_NAME)

/**
 * The effort a fresh selection of `harness · model` opens with: its star while
 * the menu still offers that level, else the configured default ("" leaves it
 * to the adapter). A stale star is skipped, never sent.
 */
export function seededEffort(
  connectionId: string,
  harness: HarnessInfo | undefined,
  model: string | undefined,
  preferred: PreferredEfforts,
  storage?: ReadWriteStorage
): string {
  if (!harness) return ""
  const starred = model ? preferredEffortFor(preferred, harness.name, model) : null
  if (
    starred &&
    harness.hasEffort &&
    effortOptions(connectionId, harness, storage).includes(starred)
  )
    return starred
  return harness.defaults.reasoningEffort ?? ""
}
