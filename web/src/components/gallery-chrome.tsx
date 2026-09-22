import type { ReactNode } from "react"

import { Eyebrow, Rule } from "@/components/primitives"

/**
 * The gallery's own layout furniture — the parts every specimen sits in
 * rather than any one of them. Split out of `gallery.tsx` so the page can
 * keep growing a section at a time without the file itself becoming the
 * thing under review.
 */
export function Section({ title, children }: { title: string; children: ReactNode }) { return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>{title}</Eyebrow>
        <Rule />
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">{children}</div>
    </section>
  )
}

export function TextRow({ cls, name, note }: { cls: string; name: string; note: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className={`w-[300px] shrink-0 text-[13px] ${cls}`}>The quick brown fox jumps over</span>
      <span className="flex-1 text-[11px] text-muted-foreground">{note}</span>
      <span className="font-mono text-[10.5px] text-faint">{name}</span>
    </div>
  )
}

export function Specimen({ spec, children }: { spec: string; children: ReactNode }) {
  return (
    <div>
      {children}
      <div className="mt-1.5 font-mono text-[11px] text-faint">{spec}</div>
    </div>
  )
}

export function MetricRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[110px] shrink-0 text-[12px] text-fg-secondary">{label}</span>
      {children}
    </div>
  )
}
