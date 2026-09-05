import type { HarnessInfo } from "@/lib/types"

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
const MAX_PER_HARNESS = 6

type Recents = Record<string, string[]>

function read(): Recents {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    // hand-editable storage is untrusted: keep only string[] entries
    const out: Recents = {}
    for (const [harness, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[harness] = list.filter((v): v is string => typeof v === "string" && v !== "")
    }
    return out
  } catch {
    return {}
  }
}

/** Levels used before on this machine, newest first. */
export function recentEfforts(harness: string): string[] {
  return read()[harness] ?? []
}

/** Remember a level the user actually submitted, newest first, capped. */
export function rememberEffort(harness: string, effort: string): void {
  const value = effort.trim()
  if (!value) return
  const all = read()
  const next = [value, ...(all[harness] ?? []).filter((v) => v !== value)].slice(0, MAX_PER_HARNESS)
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...all, [harness]: next }))
  } catch {
    // a full or blocked store costs us a convenience, not a feature
  }
}

/**
 * What the effort menu shows: the harness's own levels in the order it names
 * them (low→max reads as a ladder, so preserve it), then anything used here
 * that the harness did not declare — a stale list must never hide a level that
 * actually works. Never empty when either source has something, and never
 * invented when both are empty.
 */
export function effortOptions(h: HarnessInfo): string[] {
  const declared = h.effortLevels ?? []
  const local = [h.defaults.reasoningEffort, ...recentEfforts(h.name)]
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of [...declared, ...local]) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
