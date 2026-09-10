import { Effort, Sparkle } from "@/components/icons"
import {
  Menu,
  MenuGroup,
  MenuNote,
  MenuRadioGroup,
  MenuRadioItem,
} from "@/components/menu"
import { effortOptions } from "@/lib/effort"
import {
  defaultModelFor,
  isUsable,
  modelOptionsFor,
  orderHarnesses,
  unusableReason,
} from "@/lib/model-choice"
import { useDaemonRuntime } from "@/lib/runtime"
import type { HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

export interface TaskAgentChoice {
  harness: string
  model: string
  effort: string | null
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
        className={cn("min-w-0 max-w-full", touch && "shrink")}
      >
        {ordered.length === 0 ? (
          <MenuNote>No harnesses reported by the daemon.</MenuNote>
        ) : (
          <MenuRadioGroup
            value={encode(value.harness, value.model)}
            onValueChange={(encoded) => {
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
              })
            }}
          >
            {ordered.map((harness) => (
              <MenuGroup
                key={harness.name}
                label={harness.name}
                hint={isUsable(harness) ? undefined : unusableReason(harness)}
              >
                {isUsable(harness) ? (
                  modelOptionsFor(harness).map((model) => (
                    <MenuRadioItem
                      key={model}
                      value={encode(harness.name, model)}
                      hint={model === defaultModelFor(harness) ? "default" : undefined}
                    >
                      {model}
                    </MenuRadioItem>
                  ))
                ) : (
                  <MenuNote>Unavailable here</MenuNote>
                )}
              </MenuGroup>
            ))}
          </MenuRadioGroup>
        )}
      </Menu>
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
    </>
  )
}
