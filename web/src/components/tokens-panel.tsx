import { memo, useMemo } from "react"

import { Eyebrow } from "@/components/primitives"
import { ReportPanel } from "@/components/report-panel"
import { useTokensReport, type TokensReportProps } from "@/hooks/useTokensReport"
import type { ApiTask, Turn } from "@/lib/types"
import { reportedUsageTurns, totalUsage, usageParts } from "@/lib/usage"

/**
 * Wisp's /tokens answer: token telemetry captured from this task's settled
 * turns. It is intentionally distinct from a harness account-usage probe.
 */
function TokensPanelView({ onClose, className, ...report }: TokensReportProps & { onClose: () => void; className?: string }) {
  return (
    <ReportPanel
      testId="tokens-panel"
      title="/tokens"
      source={`Wisp · ${report.harness}`}
      onClose={onClose}
      className={className}
    >
      <TokensReport {...report} />
    </ReportPanel>
  )
}

/** The report's body, without the panel around it: the summary card's Context row draws it in place. */
export function TokensReport({
  harness,
  turns,
  total: taskTotal,
  reportingTurns,
  hasOlderTurns = false,
  loading = false,
  error = null,
}: TokensReportProps) {
  const reported = useMemo(() => reportedUsageTurns(turns), [turns])
  const visibleTotal = useMemo(() => totalUsage(reported.map((turn) => turn.usage)), [reported])
  const total = taskTotal ?? visibleTotal
  const reportCount = reportingTurns ?? reported.length

  return (
    <>
      {loading ? (
        <p className="text-[11.5px] text-muted-foreground">Loading task token usage…</p>
      ) : error instanceof Error ? (
        <p role="alert" className="text-[11.5px] text-destructive">
          Could not load token usage: {error.message}
        </p>
      ) : reportCount === 0 ? (
        <p className="text-[11.5px] text-muted-foreground">
          No turn has reported token usage yet. Usage arrives after a turn settles.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <Eyebrow>Task total</Eyebrow>
            <p data-testid="tokens-total" className="mt-1 text-[12px] text-foreground">
              {usageParts(total).join(" · ")}
            </p>
            <p className="mt-0.5 text-[10.5px] text-faint">
              Sum of {reportCount} reporting turn{reportCount === 1 ? "" : "s"}
            </p>
          </div>

          <div>
            <Eyebrow>By turn</Eyebrow>
            <div className="mt-1 space-y-0.5">
              {reported.map((turn) => (
                <div key={turn.id} className="flex items-baseline gap-3 text-[11.5px]">
                  <span className="w-12 shrink-0 text-muted-foreground">turn {turn.n}</span>
                  <span className="min-w-0 flex-1 font-mono text-foreground tabular-nums">
                    {usageParts(turn.usage).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
            {hasOlderTurns && (
              <p className="mt-1 text-[10.5px] text-faint">
                Showing the newest {reported.length} reporting turn{reported.length === 1 ? "" : "s"}.
              </p>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-2 text-[10.5px] leading-relaxed text-faint">
        Task-level tokens reported by settled {harness} turns. This is not an account subscription, quota, or cost
        gauge.
      </p>
    </>
  )
}

export const TokensPanel = memo(TokensPanelView)

/** The report for one task, asked for while it is mounted: the summary card's Context row, open. */
export function TaskTokensReport({ task, turns }: { task: ApiTask; turns: Turn[] | undefined }) {
  const report = useTokensReport(task, turns, true)
  return report ? <TokensReport {...report} /> : null
}
