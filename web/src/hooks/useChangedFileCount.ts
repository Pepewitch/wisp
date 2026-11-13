import { useQuery } from "@tanstack/react-query"

import { parsedDiff, useDiff, useHarnessFeatures } from "@/hooks/queries"
import { ApiError } from "@/lib/api"
import { changedFileCount } from "@/lib/diff"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask, DiffSummary } from "@/lib/types"

/**
 * GET /api/tasks/:id/diff/summary: the file count the Changes pane would
 * show, without the diff. Its key sits under the full diff's, so every
 * refresh of the diff (a turn ending, a reconnect, the pane's own refresh)
 * refreshes the count too. `null` is the pane's muted states: an archived
 * task, no worktree, or one git can no longer read.
 */
function useDiffSummary(id: string, enabled: boolean) {
  const { transport, qk } = useDaemonRuntime()
  return useQuery({
    queryKey: [...qk.diff(id), "summary"],
    enabled,
    queryFn: async ({ signal }): Promise<number | null> => {
      try {
        const summary = await transport.request<DiffSummary>(`/api/tasks/${id}/diff/summary`, { signal })
        return summary.worktreeReason === null ? summary.files : null
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return null
        throw e
      }
    },
  })
}

/**
 * How many files a task has changed, for the Changes tool's hint. The whole
 * diff (up to 512 KiB, and a full `git diff`) used to be fetched on every
 * task open and every turn just to be counted; now only the Changes pane
 * fetches it. A daemon without the summary route still gets counted from the
 * full diff, so the hint reads the same against either.
 */
export function useChangedFileCount(task: Pick<ApiTask, "id" | "archived">): number {
  const features = useHarnessFeatures()
  const answered = features.data !== undefined || features.isError
  const summarized = features.data?.diffSummary === true
  const summary = useDiffSummary(task.id, summarized && !task.archived)
  const diff = useDiff(answered && !summarized ? task.id : null, task.archived).data
  if (summarized) return summary.data ?? 0
  return diff?.kind === "ok" ? changedFileCount(parsedDiff(diff).files, diff.untracked) : 0
}
