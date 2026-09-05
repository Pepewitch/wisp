import { ConnectionChromeSpecimen } from "@/components/connection-chrome"
import { Eyebrow, Rule } from "@/components/primitives"

export function ConnectionGallerySpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>
          Desktop connections — identity, selection and quiet attention
        </Eyebrow>
        <Rule />
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">
        <ConnectionChromeSpecimen />
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          Local is always first and uses a computer; remotes use a cloud.
          Selection stays neutral. An inactive daemon earns only its
          highest-priority task-state dot, so attention is visible without
          mounting another conversation or terminal tree.
        </p>
      </div>
    </section>
  )
}
