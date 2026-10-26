import { useTaskUsage } from "@/hooks/queries"
import { ApiError } from "@/lib/api"
import type { Turn, UsageSummary } from "@/lib/types"

/** What the report draws: the task's usage answer, or a legacy daemon's conversation turns. */
export interface TokensReportProps {
  harness: string
  /** GET /api/tasks/:id/usage's turns, or a legacy daemon's conversation turns (usage may be null). */
  turns: Pick<Turn, "id" | "n" | "usage">[] | undefined
  total?: UsageSummary
  reportingTurns?: number
  hasOlderTurns?: boolean
  loading?: boolean
  error?: unknown
}

/**
 * GET /api/tasks/:id/usage, asked only while a report is on screen: the
 * composer's `/tokens` and the summary card's Context row share this one key.
 * A daemon from before the route answers 404, and then the conversation's own
 * turns stand in for it.
 */
export function useTokensReport(
  task: { id: string; harness: string } | null,
  turns: Pick<Turn, "id" | "n" | "usage">[] | undefined,
  enabled: boolean,
): TokensReportProps | null {
  const usage = useTaskUsage(task?.id ?? null, enabled && task !== null)
  if (!task) return null
  const legacy = usage.error instanceof ApiError && usage.error.status === 404
  return {
    harness: task.harness,
    turns: usage.data?.turns ?? (legacy ? turns : undefined),
    total: usage.data?.total,
    reportingTurns: usage.data?.reporting_turns,
    hasOlderTurns: usage.data?.has_older_turns,
    loading: usage.isPending,
    error: legacy ? null : usage.error,
  }
}
