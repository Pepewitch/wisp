import { memo, useMemo } from "react"

import { Eyebrow } from "@/components/primitives"
import { ReportPanel } from "@/components/report-panel"
import type { Turn } from "@/lib/types"
import { reportedUsageTurns, totalUsage, usageParts } from "@/lib/usage"

/**
 * Wisp's /tokens answer: token telemetry captured from this task's settled
 * turns. It is intentionally distinct from a harness account-usage probe.
 */
function TokensPanelView({
  harness,
  turns,
  onClose,
  className,
}: {
  harness: string
  turns: Turn[] | undefined
  onClose: () => void
  className?: string
}) {
  const reported = useMemo(() => reportedUsageTurns(turns), [turns])
  const total = useMemo(() => totalUsage(reported.map((turn) => turn.usage)), [reported])

  return (
    <ReportPanel
      testId="tokens-panel"
      title="/tokens"
      source={`Wisp · ${harness}`}
      onClose={onClose}
      className={className}
    >
      {reported.length === 0 ? (
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
              Sum of {reported.length} reporting turn{reported.length === 1 ? "" : "s"}
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
          </div>
        </div>
      )}

      <p className="mt-3 border-t border-border pt-2 text-[10.5px] leading-relaxed text-faint">
        Task-level tokens reported by settled {harness} turns. This is not an account subscription, quota, or cost
        gauge.
      </p>
    </ReportPanel>
  )
}

export const TokensPanel = memo(TokensPanelView)
