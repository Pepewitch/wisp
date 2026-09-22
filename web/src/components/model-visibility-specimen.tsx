import { useState } from "react"

import { ModelMenuFooter, ModelMenuGroups } from "@/components/model-menu"
import { ModelCuration } from "@/components/model-visibility-dialog"
import { Menu, MenuRadioGroup } from "@/components/menu"
import { Sparkle } from "@/components/icons"
import { Eyebrow, POPOVER_SURFACE, Rule } from "@/components/primitives"
import { hiddenTotal, type HiddenModels } from "@/lib/model-visibility"
import type { HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Enough of a catalog to show what a curated list saves you. */
const HARNESSES: HarnessInfo[] = [
  {
    name: "claude",
    hasModel: true,
    hasEffort: true,
    hasImage: true,
    defaults: { model: "claude-opus-5" },
    models: {
      list: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
      defaultModel: "claude-opus-5",
      probedAt: "2026-09-22T00:00:00.000Z",
    },
  },
  {
    name: "codex",
    hasModel: true,
    hasEffort: true,
    hasImage: true,
    defaults: { model: "gpt-5.6-luna" },
    models: {
      list: ["gpt-5.6-luna", "gpt-5.6-luna-codex", "gpt-6-astra", "gpt-6-astra-mini", "o4-mini"],
      defaultModel: "gpt-5.6-luna",
      probedAt: "2026-09-22T00:00:00.000Z",
    },
  },
  {
    name: "cursor",
    hasModel: true,
    hasEffort: false,
    hasImage: true,
    defaults: {},
    models: {
      list: ["auto", "composer-2.5", "cursor-muse-1", "claude-opus-4-8-high", "gpt-5.6-sol"],
      defaultModel: "auto",
      probedAt: "2026-09-22T00:00:00.000Z",
    },
  },
]

const HIDDEN: HiddenModels = {
  claude: ["claude-fable-5-1", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.6-luna-codex", "gpt-6-astra-mini", "o4-mini"],
  cursor: ["auto", "composer-2.5", "cursor-muse-1", "claude-opus-4-8-high", "gpt-5.6-sol"],
}

const encode = (harness: string, model: string) => `${harness}\t${model}`

/**
 * The two halves of model visibility, side by side: the menu a curation
 * shortens, and the manager that writes it. Both are live — toggling here
 * moves local state only, so the page is a sandbox rather than a screenshot.
 */
export function ModelVisibilitySpecimen() {
  const [hidden, setHidden] = useState<HiddenModels>(HIDDEN)
  const [revealed, setRevealed] = useState(false)
  const selected = { harness: "claude", model: "claude-opus-5" }

  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>Models — the picker is curated, the catalog is not</Eyebrow>
        <Rule />
      </div>
      <div className="flex flex-wrap items-start gap-8 rounded-xl border border-border bg-surface p-5">
      <div>
        <Eyebrow>The picker, curated</Eyebrow>
        {/* the real dropdown, not a mock of one: base-ui owns the popup, so
            this opens on a click the way it does in the composer */}
        <div className="mt-2.5 w-[264px]">
          <Menu
            icon={<Sparkle />}
            label={
              <>
                {selected.harness}
                <span className="font-mono text-muted-foreground"> · {selected.model}</span>
              </>
            }
            onOpenChange={(open) => {
              if (!open) setRevealed(false)
            }}
          >
            <MenuRadioGroup
              value={encode(selected.harness, selected.model)}
              onValueChange={() => setRevealed((on) => !on)}
            >
              <ModelMenuGroups
                harnesses={HARNESSES}
                hidden={hidden}
                revealed={revealed}
                selected={selected}
                encode={encode}
                onHiddenChange={setHidden}
              />
              <ModelMenuFooter
                hiddenCount={hiddenTotal(HARNESSES, hidden)}
                revealed={revealed}
                manageable
              />
            </MenuRadioGroup>
          </Menu>
        </div>
      </div>

      <div className={cn("w-[520px] overflow-hidden rounded-xl", POPOVER_SURFACE)}>
        <div className="flex items-baseline gap-2.5 border-b border-border px-4 py-3">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">Models</h2>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
            Which models the picker offers on this daemon
          </span>
        </div>
        <ModelCuration
          harnesses={HARNESSES}
          hidden={hidden}
          onApply={setHidden}
          empty="No harnesses reported by the daemon."
          error={null}
        />
      </div>

      <p className="min-w-[280px] flex-1 text-[11.5px] leading-relaxed text-muted-foreground">
        opencode's probe reports ~150 ids and cursor's the whole catalog, so a picker that shows every
        one of them is mostly scroll. Hiding is a <span className="font-mono">DENYLIST</span> in daemon
        settings: a model a later probe finds appears on its own, and the curation follows the daemon
        rather than one browser. <span className="text-fg-secondary">cursor</span> has nothing shown
        here, so it drops out of the menu entirely — the footer's count is what says it is still out
        there, and <span className="text-fg-secondary">Show N hidden</span> brings it back for this one
        opening. The eye on a row is a pointer affordance: it appears on hover and on keyboard
        highlight, never on a coarse pointer, where the manager does the job instead.
      </p>
      </div>
    </section>
  )
}
