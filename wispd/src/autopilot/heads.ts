/** What a checkpoint remembers of the PR's heads: when Wisp first saw each. */
import type { PrSnapshot } from "./github"
import type { AutopilotCheckpoint } from "./store"

/** The earliest this head could have been reviewed: its commit, or when Wisp first saw it. */
export function headSince(checkpoint: AutopilotCheckpoint, pr: PrSnapshot): number {
  const times = [checkpoint.heads?.[pr.head], pr.headCommittedAt].map((at) => Date.parse(at ?? "")).filter(Number.isFinite)
  return times.length > 0 ? Math.min(...times) : 0
}

/** When Wisp first saw this head, or `nowMs` if it has no record of it. */
export function headFirstSeen(checkpoint: AutopilotCheckpoint, pr: PrSnapshot, nowMs: number): number {
  const seen = Date.parse(checkpoint.heads?.[pr.head] ?? "")
  return Number.isFinite(seen) ? seen : nowMs
}

/** The last few heads seen, and always the current one. */
export function trimHeads(heads: Record<string, string>, current: string): Record<string, string> {
  const kept = Object.entries(heads).filter(([sha]) => sha !== current).sort((a, b) => a[1].localeCompare(b[1])).slice(-4)
  return Object.fromEntries([...kept, [current, heads[current]!]])
}
