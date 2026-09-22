import { useState } from "react"

import { FastModeToggle } from "@/components/fast-mode-toggle"
import { Effort, Sparkle } from "@/components/icons"
import { Menu, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { ModelMenuFooter, ModelMenuGroups } from "@/components/model-menu"
import { ModelVisibilityDialog } from "@/components/model-visibility-dialog"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { effortOptions } from "@/lib/effort"
import { MENU_ACTION } from "@/lib/menu-actions"
import { orderHarnesses } from "@/lib/model-choice"
import { hiddenTotal } from "@/lib/model-visibility"
import { useDaemonRuntime } from "@/lib/runtime"
import type { HarnessInfo } from "@/lib/types"

export interface TaskAgentChoice {
  harness: string
  model: string
  effort: string | null
  /** Fast mode, for a harness that reports the lane; always false without one. */
  fast: boolean
}

const encode = (harness: string, model: string) => `${harness}\t${model}`
const DEFAULT_EFFORT = "__harness_default__"

export function TaskAgentPicker({
  harnesses,
  value,
  disabled,
  touch = false,
  onChange,
}: {
  harnesses: HarnessInfo[]
  value: TaskAgentChoice
  disabled: boolean
  /** Thumb-sized triggers, and the short labels a phone-width bar can hold. */
  touch?: boolean
  onChange: (choice: TaskAgentChoice) => void
}) {
  const { connectionId } = useDaemonRuntime()
  const ordered = orderHarnesses(harnesses)
  const selected = ordered.find((candidate) => candidate.name === value.harness)
  const efforts = selected ? effortOptions(connectionId, selected) : []
  const { hidden, supported, setHidden } = useHiddenModels()
  const [menuOpen, setMenuOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [managing, setManaging] = useState(false)
  const choice = { harness: value.harness, model: value.model }

  return (
    <>
      <Menu
        // A mono model name under a chevron needs no sparkle to say it is the
        // agent, and dropping the glyph is what buys the name room to stay
        // un-truncated on a phone — beside a row of glyph controls, one text
        // chip also groups itself.
        icon={touch ? undefined : <Sparkle />}
        touch={touch}
        // On touch the task header carries harness · model un-truncated one
        // band up, so the chip only has to name the model the next turn goes
        // to — and it is the one thing in this bar allowed to shrink.
        label={
          touch ? (
            <span className="font-mono">{value.model}</span>
          ) : (
            <>
              {value.harness}
              <span className="font-mono text-muted-foreground"> · {value.model}</span>
            </>
          )
        }
        aria-label={touch ? `${value.harness} · ${value.model}` : undefined}
        disabled={disabled || ordered.length === 0}
        // the one control in the bar allowed to yield width: it truncates
        // inside its own box, the way the create dialog's harness chip does
        className="min-w-0 max-w-full shrink"
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          // the reveal is scoped to ONE opening: a curated list is what the
          // next open is for, and a sticky reveal would quietly undo it
          if (!open) setRevealed(false)
        }}
      >
        {ordered.length === 0 ? (
          <MenuNote>No harnesses reported by the daemon.</MenuNote>
        ) : (
          <MenuRadioGroup
            value={encode(value.harness, value.model)}
            onValueChange={(encoded) => {
              if (encoded === MENU_ACTION.revealModels) return setRevealed((on) => !on)
              if (encoded === MENU_ACTION.manageModels) {
                setMenuOpen(false)
                return setManaging(true)
              }
              const split = encoded.indexOf("\t")
              const harness = encoded.slice(0, split)
              const model = encoded.slice(split + 1)
              const destination = ordered.find((candidate) => candidate.name === harness)
              onChange({
                harness,
                model,
                effort:
                  harness === value.harness
                    ? value.effort
                    : destination?.defaults.reasoningEffort ?? null,
                // crossing harnesses drops fast mode: the destination may not
                // sell the lane, and the daemon refuses a tier it has no
                // template for. Staying put keeps the current choice.
                fast:
                  harness === value.harness
                    ? value.fast
                    : Boolean(destination?.hasFastMode) && value.fast,
              })
            }}
          >
            <ModelMenuGroups
              harnesses={ordered}
              hidden={hidden}
              revealed={revealed}
              selected={choice}
              encode={encode}
              onHiddenChange={supported ? setHidden : undefined}
            />
            <ModelMenuFooter
              hiddenCount={hiddenTotal(ordered, hidden)}
              revealed={revealed}
              manageable={supported}
            />
          </MenuRadioGroup>
        )}
      </Menu>
      {selected?.hasFastMode && (
        <FastModeToggle
          value={value.fast}
          disabled={disabled}
          touch={touch}
          onChange={(fast) => onChange({ ...value, fast })}
        />
      )}
      {selected?.hasEffort && efforts.length > 0 && (
        <Menu
          icon={<Effort />}
          touch={touch}
          // On touch the value alone, and the glyph alone while the harness
          // default stands: "xhigh effort" spelt out beside a model chip is
          // what used to push this bar past a phone's width.
          iconOnly={touch && !value.effort}
          label={
            touch
              ? value.effort ?? "Reasoning effort"
              : value.effort
                ? `${value.effort} effort`
                : "Default effort"
          }
          aria-label={
            touch && value.effort ? `Reasoning effort: ${value.effort}` : undefined
          }
          disabled={disabled}
        >
          <MenuRadioGroup
            value={value.effort ?? DEFAULT_EFFORT}
            onValueChange={(effort) =>
              onChange({
                ...value,
                effort: effort === DEFAULT_EFFORT ? null : effort,
              })
            }
          >
            <MenuRadioItem value={DEFAULT_EFFORT}>Harness default</MenuRadioItem>
            {efforts.map((effort) => (
              <MenuRadioItem key={effort} value={effort}>
                {effort}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
      )}
      <ModelVisibilityDialog open={managing} onOpenChange={setManaging} />
    </>
  )
}
