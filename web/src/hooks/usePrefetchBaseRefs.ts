import { useEffect, useRef } from "react"

import { useDaemonRuntime } from "@/lib/runtime"

/** How long the composer's project, mode and prompt must hold still before it asks. */
export const PREFETCH_DEBOUNCE_MS = 400

/**
 * The least time between two asks while someone keeps typing. Above wispd's
 * PREFETCH_COOLDOWN_MS (15 s), so each ask can start a fetch, and below its
 * BASE_REFS_FRESH_MS (30 s), so Start pressed mid-sentence finds a fetch
 * recent enough for the create to skip its own.
 */
export const PREFETCH_REWARM_MS = 20_000

/**
 * Warm the daemon's `git fetch origin` for a worktree task while it is still
 * being written, so pressing Start does not wait on it (wispd base-refs.ts).
 *
 * Asked when the composer opens, when its project or mode changes, and again
 * at most every PREFETCH_REWARM_MS while the prompt keeps changing: a task can
 * take minutes to write, and one fetch at open would be stale by Start.
 *
 * Fire and forget. Nothing reads the answer, and every failure is ignored: an
 * older daemon's 404, an unreachable one, a project removed meanwhile. The
 * worst case is the create fetching for itself, which is what it always did.
 * A local task has no base to fetch, so it asks nothing.
 */
export function usePrefetchBaseRefs(repoPath: string, worktree: boolean, prompt: string): void {
  const { transport } = useDaemonRuntime()
  const lastAsked = useRef<{ key: string; at: number } | null>(null)
  useEffect(() => {
    if (!worktree || repoPath === "") return
    const key = `${transport.connectionId}\n${repoPath}`
    const last = lastAsked.current
    if (last?.key === key && Date.now() - last.at < PREFETCH_REWARM_MS) return
    const timer = setTimeout(() => {
      lastAsked.current = { key, at: Date.now() }
      transport
        .request("/api/projects/base-refs", { method: "POST", body: { path: repoPath } })
        .catch(() => {})
    }, PREFETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [transport, repoPath, worktree, prompt])
}
