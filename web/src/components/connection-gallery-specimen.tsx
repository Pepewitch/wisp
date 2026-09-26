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
          Selection stays neutral. The connection dot is green while the server
          and live updates work, rings green while updates connect, turns yellow
          when updates are delayed, and red when the server cannot be reached.
          Click it to reconnect.
          An inactive daemon also earns its highest-priority task-state dot,
          so attention is visible without mounting another conversation tree.
        </p>
      </div>
    </section>
  )
}
