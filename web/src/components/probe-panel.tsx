import { Prose } from "@/components/prose"
import { Eyebrow } from "@/components/primitives"
import { ReportPanel } from "@/components/report-panel"
import { formatTokens } from "@/lib/format"
import { since } from "@/lib/state"
import type { ContextBreakdown, HarnessUsageReport, ProbeAnswer, ProbeCommandName } from "@/lib/types"

/**
 * The probe-result panel (A3). A probe's answer is a REPORT, not a chat bubble
 * and not a one-line note: claude's `/context` alone is a page of markdown
 * with tables, and droid/codex answer with structured numbers Wisp owns the
 * rendering of. So the answer floats above the composer like the palette does,
 * in the surface the app already has for exactly this, and stays until it is
 * dismissed or the task changes.
 *
 * Honesty rules (SP1): `cached` is marked because a cached number can be stale
 * and staleness is news; a fresh answer says only when it was probed. An empty
 * section renders NO section — the harness saying nothing is not a table with
 * invented zeros. A REFUSAL never reaches this panel: it is a one-line note
 * above the composer, same as every other command's.
 */
export function ProbePanel({
  harness,
  command,
  answer,
  onClose,
  className,
}: {
  harness: string
  command: ProbeCommandName
  /** null while the probe is in flight — droid's path can take 10s+ (SP1) */
  answer: ProbeAnswer | null
  onClose: () => void
  className?: string
}) {
  // Escape is handled by the composer's own key handler (CONVENTIONS §5e:
  // nothing above the composer installs a document-level one)
  return (
    <ReportPanel
      testId="probe-panel"
      title={`/${command}`}
      source={harness}
      aside={
        answer && (
          <span className="shrink-0 text-[10.5px] text-faint">
            {answer.cached ? `cached · ${since(answer.probedAt)}` : since(answer.probedAt)}
          </span>
        )
      }
      onClose={onClose}
      className={className}
    >
      {answer === null ? (
        <p className="text-[11.5px] text-muted-foreground">asking the harness…</p>
      ) : answer.report.format === "markdown" ? (
        <Prose text={answer.report.text} className="text-[12px]" />
      ) : answer.report.format === "context" ? (
        <ContextReport context={answer.report.context} />
      ) : (
        <UsageReport usage={answer.report.usage} />
      )}
    </ReportPanel>
  )
}

/** droid's breakdown, as tables Wisp owns the vocabulary of. */
function ContextReport({ context }: { context: ContextBreakdown }) {
  const fmt = (n: number | null) => (n === null ? "—" : formatTokens(n))
  return (
    <div data-testid="probe-context" className="space-y-2.5">
      <p className="text-[11.5px] text-muted-foreground">
        {[
          context.model,
          context.usedTokens !== null && context.budgetTokens !== null
            ? `${fmt(context.usedTokens)} of ${fmt(context.budgetTokens)}`
            : null,
          context.freeTokens !== null ? `${fmt(context.freeTokens)} free` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <Section label="Categories" rows={context.categories.map((c) => [c.name, fmt(c.tokens)])} />
      <Section label="Skills" rows={context.skills.map((s) => [s.name, fmt(s.tokens)])} />
      <Section
        label="MCP servers"
        rows={context.mcpServers.map((m) => [
          m.name,
          [m.toolCount !== null ? `${m.toolCount} tools` : null, m.tokens !== null ? fmt(m.tokens) : null]
            .filter(Boolean)
            .join(" · "),
        ])}
      />
    </div>
  )
}

/** codex's rate limits and lifetime usage, same table law. */
function UsageReport({ usage }: { usage: HarnessUsageReport }) {
  const windowRow = (label: string, w: HarnessUsageReport["primary"]) => {
    if (!w) return null
    return [
      label,
      [
        w.usedPercent !== null ? `${w.usedPercent}% used` : null,
        w.windowMins !== null ? `${windowLabel(w.windowMins)} window` : null,
        w.resetsAt !== null ? `resets ${until(w.resetsAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ] as [string, string]
  }
  const rows = [
    usage.planType !== null ? (["plan", usage.planType] as [string, string]) : null,
    windowRow("this window", usage.primary),
    windowRow("weekly", usage.secondary),
    usage.credits !== null
      ? ([
          "credits",
          usage.credits.unlimited
            ? "unlimited"
            : usage.credits.hasCredits
              ? (usage.credits.balance ?? "available")
              : "none",
        ] as [string, string])
      : null,
    usage.lifetimeTokens !== null ? (["lifetime", `${formatTokens(usage.lifetimeTokens)} tokens`] as [string, string]) : null,
  ].filter((r): r is [string, string] => r !== null)
  return (
    <div data-testid="probe-usage" className="space-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-3 text-[11.5px]">
          <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 flex-1 text-foreground">{value}</span>
        </div>
      ))}
    </div>
  )
}

/** One named block of label/value rows; an empty one renders nothing. */
function Section({ label, rows }: { label: string; rows: [string, string][] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <Eyebrow className="mb-1">{label}</Eyebrow>
      <div className="space-y-0.5">
        {rows.map(([name, value]) => (
          <div key={name} className="flex items-baseline gap-3 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
            <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 300 → "5h", 10080 → "7d" — a rate-limit window, in the units resets use. */
function windowLabel(mins: number): string {
  if (mins % 10080 === 0) return `${mins / 10080}d`
  if (mins % 1440 === 0) return `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

/** "in 3h" — resetsAt is a FUTURE time, and `since()` only speaks of the past. */
function until(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (!Number.isFinite(mins) || mins < 1) return "soon"
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}
