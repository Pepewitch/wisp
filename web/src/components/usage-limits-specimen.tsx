import { Eyebrow, Rule } from "@/components/primitives"
import { UsageLimitsPopover, UsageRing } from "@/components/usage-limits-control"
import type { HarnessLimitsEntry, LimitWindow } from "@/lib/types"
import { ringReading, type RingReading } from "@/lib/usage-limits"

const HOUR = 3_600_000
/** Resets relative to the gallery's own render, so the countdowns always read as the future. */
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString()
const fetchedAt = new Date(Date.now() - 40_000).toISOString()

const window = (over: Partial<LimitWindow> & Pick<LimitWindow, "id" | "label" | "usedPercent">): LimitWindow => ({
  pool: null,
  resetsAt: null,
  windowMins: null,
  ...over,
})

const USAGE_LIMITS_SPECIMEN: HarnessLimitsEntry[] = [
  {
    name: "claude",
    status: "ok",
    limits: {
      plan: null,
      windows: [
        window({ id: "session", label: "5h", usedPercent: 33, resetsAt: at(3.8), windowMins: 300 }),
        window({ id: "week", label: "7d", usedPercent: 84, resetsAt: at(98), windowMins: 10_080 }),
        window({ id: "week:opus", label: "Opus", model: "Opus", usedPercent: 0, resetsAt: at(98), windowMins: 10_080 }),
      ],
    },
    message: null,
    fetchedAt,
    cached: true,
  },
  {
    name: "droid",
    status: "ok",
    limits: {
      plan: null,
      account: "verified",
      windows: [
        window({ id: "standard:fiveHour", label: "5h", pool: "standard", usedPercent: 12, resetsAt: at(2.5), windowMins: 300 }),
        window({ id: "standard:weekly", label: "weekly", pool: "standard", usedPercent: 40, resetsAt: at(70), windowMins: 10_080 }),
        window({ id: "standard:monthly", label: "monthly", pool: "standard", usedPercent: 71, resetsAt: at(400) }),
        window({ id: "core:fiveHour", label: "5h", pool: "core", usedPercent: 0, windowMins: 300 }),
        window({ id: "core:weekly", label: "weekly", pool: "core", usedPercent: 100, resetsAt: at(20), windowMins: 10_080 }),
        window({ id: "core:monthly", label: "monthly", pool: "core", usedPercent: 5, resetsAt: at(400) }),
      ],
    },
    message: null,
    fetchedAt,
    cached: true,
  },
  {
    name: "codex",
    status: "ok",
    limits: {
      plan: "team",
      windows: [window({ id: "codex:primary", label: "7d", usedPercent: 21, resetsAt: at(130), windowMins: 10_080 })],
    },
    message: null,
    fetchedAt,
    cached: true,
  },
]

const NEEDS_KEY: HarnessLimitsEntry[] = [
  USAGE_LIMITS_SPECIMEN[0]!,
  {
    name: "droid",
    status: "needs-key",
    limits: null,
    message: "Add a Factory API key in Settings to show droid's limits.",
    fetchedAt,
    cached: false,
  },
  {
    name: "codex",
    status: "error",
    limits: null,
    message: "the codex limits read timed out after 20s",
    fetchedAt,
    cached: false,
  },
]

const ring = (...windows: LimitWindow[]): RingReading | null =>
  ringReading({ name: "claude", status: "ok", limits: { plan: null, windows }, message: null, fetchedAt, cached: true })

const RINGS: { label: string; reading: RingReading | null }[] = [
  { label: "No task, or no limits read", reading: null },
  { label: "33% · neutral", reading: ring(window({ id: "a", label: "5h", usedPercent: 33, windowMins: 300 })) },
  { label: "84% · amber", reading: ring(window({ id: "b", label: "5h", usedPercent: 84, windowMins: 300 })) },
  { label: "Reached · destructive", reading: ring(window({ id: "c", label: "5h", usedPercent: 99, windowMins: 300 })) },
  {
    label: "10%, but 7d reached · destructive",
    reading: ring(
      window({ id: "d", label: "5h", usedPercent: 10, windowMins: 300 }),
      window({ id: "e", label: "7d", usedPercent: 100, windowMins: 10_080 }),
    ),
  },
]

/**
 * The usage ring's five readings, and the popover open in its two shapes:
 * every harness reporting, and the ways a harness can have nothing to show.
 */
export function UsageLimitsSpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>Usage limits — a ring for this task, every plan window on hover</Eyebrow>
        <Rule />
      </div>
      <div className="flex flex-wrap items-center gap-6 rounded-xl border border-border bg-surface px-5 py-3">
        {RINGS.map((specimen) => (
          <span key={specimen.label} className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <span className="flex size-[22px] items-center justify-center [&>svg]:size-3.5">
              <UsageRing reading={specimen.reading} />
            </span>
            {specimen.label}
          </span>
        ))}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="flex min-h-[520px] justify-end rounded-xl border border-border bg-surface p-5">
          <UsageLimitsPopover
            entries={USAGE_LIMITS_SPECIMEN}
            harness="claude"
            onRefresh={() => undefined}
            onOpenSettings={() => undefined}
            defaultOpen
          />
        </div>
        <div className="flex min-h-[520px] justify-end rounded-xl border border-border bg-surface p-5">
          <UsageLimitsPopover
            entries={NEEDS_KEY}
            harness={null}
            onRefresh={() => undefined}
            onOpenSettings={() => undefined}
            defaultOpen
          />
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        The ring is the selected task&apos;s harness at its shortest main window (claude&apos;s 5h, a codex plan&apos;s 5h
        or 7d, droid&apos;s standard 5h), so it moves turn to turn. It turns destructive from 99% of that window, or
        when any other main window has reached 99%; per-model windows and droid&apos;s core pool do not count. Bars
        fill with the share used, as every harness words it, amber from 80% and destructive from 99%. A harness with nothing to show says why, and only a real
        failure is red.
      </p>
    </section>
  )
}
