import { Eyebrow, Rule } from "@/components/primitives"
import { UsageLimitsPopover, UsageRing } from "@/components/usage-limits-control"
import type { HarnessLimitsEntry, LimitWindow } from "@/lib/types"

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
        window({ id: "week:opus", label: "Opus", usedPercent: 0, resetsAt: at(98), windowMins: 10_080 }),
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

const RINGS: { label: string; window: LimitWindow | null }[] = [
  { label: "No task, or no limits read", window: null },
  { label: "33% · neutral", window: window({ id: "a", label: "5h", usedPercent: 33 }) },
  { label: "84% · amber", window: window({ id: "b", label: "7d", usedPercent: 84 }) },
  { label: "Reached · destructive", window: window({ id: "c", label: "weekly", usedPercent: 100 }) },
]

/**
 * The usage ring's four readings, and the popover open in its two shapes:
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
        {RINGS.map((ring) => (
          <span key={ring.label} className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <span className="flex size-[22px] items-center justify-center [&>svg]:size-3.5">
              <UsageRing window={ring.window} />
            </span>
            {ring.label}
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
        The ring is the selected task&apos;s harness at its most-used window, so it shows the limit that stops the next
        turn. Bars fill with the share used, as every harness words it. Hue follows the Updates dot&apos;s budget: amber
        from 80%, destructive at the limit, neutral otherwise. A harness with nothing to show says why, and only a real
        failure is red.
      </p>
    </section>
  )
}
