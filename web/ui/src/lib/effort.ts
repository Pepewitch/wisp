import type { HarnessInfo } from "@/lib/types"
import {
  readConnectionStorage,
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
