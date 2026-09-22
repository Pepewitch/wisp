import type { ReactNode } from "react"

import { Eye, EyeOff } from "@/components/icons"
import { MenuAction, MenuGroup, MenuItem, MenuRadioItem } from "@/components/menu"
import { hasCoarsePointer } from "@/hooks/useMediaQuery"
import { MENU_ACTION } from "@/lib/menu-actions"
import { defaultModelFor, isUsable, modelOptionsFor, unusableReason } from "@/lib/model-choice"
import {
  hideModel,
  isHidden,
  pickerHarnesses,
  showModel,
  visibleModelsFor,
  type HiddenModels,
} from "@/lib/model-visibility"
import type { HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The grouped model list both pickers show — the composer's (create-task
 * dialog) and the task header's (task-agent-picker).
 *
 * It lives here because hiding gave the two menus a shared vocabulary they did
 * not have before: the same filter, the same one-shot reveal, the same footer
 * counting what is missing. Duplicating that twice is how the two lists drift
 * into disagreeing about which models exist.
 *
 * Both callers still own their own `Menu` and `MenuRadioGroup`: the trigger's
 * label, the encode/decode of a choice, and what a pick MEANS (a new task vs
 * the next turn of a running one) are theirs, and a sentinel action has to be
 * recognised in the caller's own `onValueChange` anyway.
 */
export function ModelMenuGroups({
  harnesses,
  hidden,
  revealed,
  selected,
  encode,
  onHiddenChange,
  rowAction,
}: {
  harnesses: HarnessInfo[]
  hidden: HiddenModels
  /** The one-shot reveal: every hidden model shown, dimmed, for this open menu. */
  revealed: boolean
  /** The current choice, which is always offered even when it has been hidden. */
  selected: { harness: string; model: string } | null
  encode: (harness: string, model: string) => string
  /** Absent on a daemon that cannot store a curation — then no eye is offered. */
  onHiddenChange?: (next: HiddenModels) => void
  /** An extra per-row control, right of the eye (the composer's preferred star). */
  rowAction?: (harness: HarnessInfo, model: string) => ReactNode
}) {
  const shown = revealed ? harnesses : pickerHarnesses(harnesses, hidden, selected)
  return (
    <>
      {shown.map((harness) => (
        <HarnessModels
          key={harness.name}
          harness={harness}
          hidden={hidden}
          revealed={revealed}
          selected={selected}
          encode={encode}
          onHiddenChange={onHiddenChange}
          rowAction={rowAction}
        />
      ))}
    </>
  )
}

function HarnessModels({
  harness,
  hidden,
  revealed,
  selected,
  encode,
  onHiddenChange,
  rowAction,
}: {
  harness: HarnessInfo
  hidden: HiddenModels
  revealed: boolean
  selected: { harness: string; model: string } | null
  encode: (harness: string, model: string) => string
  onHiddenChange?: (next: HiddenModels) => void
  rowAction?: (harness: HarnessInfo, model: string) => ReactNode
}) {
  const keep = selected?.harness === harness.name ? selected.model : null
  const models = revealed
    ? modelOptionsFor(harness)
    : visibleModelsFor(harness, hidden, keep)
  const hiddenHere = modelOptionsFor(harness).length - visibleModelsFor(harness, hidden).length
  return (
    <MenuGroup
      label={harness.name}
      hint={
        isUsable(harness)
          ? revealed && hiddenHere > 0
            ? `${hiddenHere} hidden`
            : undefined
          : unusableReason(harness)
      }
    >
      {isUsable(harness) ? (
        models.map((model) => (
          <ModelRow
            key={model}
            harness={harness}
            model={model}
            encode={encode}
            hidden={isHidden(hidden, harness.name, model)}
            onHiddenChange={onHiddenChange}
            hiddenModels={hidden}
            rowAction={rowAction}
          />
        ))
      ) : (
        <MenuItem disabled>Unavailable here</MenuItem>
      )}
    </MenuGroup>
  )
}

function ModelRow({
  harness,
  model,
  encode,
  hidden,
  hiddenModels,
  onHiddenChange,
  rowAction,
}: {
  harness: HarnessInfo
  model: string
  encode: (harness: string, model: string) => string
  hidden: boolean
  hiddenModels: HiddenModels
  onHiddenChange?: (next: HiddenModels) => void
  rowAction?: (harness: HarnessInfo, model: string) => ReactNode
}) {
  const extra = rowAction?.(harness, model)
  // A finger reveals nothing by hovering, so the eye is a pointer affordance
  // only; on touch the manager is the whole story (see index.css).
  const eye = onHiddenChange && !hasCoarsePointer()
  const controls = (eye ? 1 : 0) + (extra ? 1 : 0)
  const label = hidden
    ? `Show ${harness.name} · ${model} in the picker`
    : `Hide ${harness.name} · ${model} from the picker`
  return (
    <div className="model-row relative">
      <MenuRadioItem
        value={encode(harness.name, model)}
        hint={hidden ? "hidden" : model === defaultModelFor(harness) ? "default" : undefined}
        className={cn(controls === 2 && "pr-14", controls === 1 && "pr-8")}
      >
        <span className={cn(hidden && "text-faint")}>{model}</span>
      </MenuRadioItem>
      {controls > 0 && (
        <span className="absolute top-1/2 right-1 z-(--z-pane) flex -translate-y-1/2 items-center gap-0.5">
          {eye && (
            <button
              type="button"
              aria-label={label}
              aria-pressed={hidden}
              title={label}
              // the row is a base-ui RadioItem: without these, pressing this
              // button also picks the model it is trying to hide
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                onHiddenChange(
                  hidden
                    ? showModel(hiddenModels, harness.name, model)
                    : hideModel(hiddenModels, harness.name, model),
                )
              }}
              className={cn(
                "model-row-action flex size-6 items-center justify-center rounded-md",
                "text-faint hover:bg-hover hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                "[&>svg]:size-3.5",
              )}
            >
              {hidden ? <Eye /> : <EyeOff />}
            </button>
          )}
          {extra}
        </span>
      )}
    </div>
  )
}

/**
 * What the shortened list owes the reader: how much of it is missing, and two
 * ways back. The count is never omitted when it is non-zero — a filtered list
 * that does not say it is filtered is a list that lies.
 */
export function ModelMenuFooter({
  hiddenCount,
  revealed,
  manageable,
}: {
  hiddenCount: number
  revealed: boolean
  /** False on a daemon that cannot store a curation: nothing to manage. */
  manageable: boolean
}) {
  if (!manageable) return null
  return (
    <>
      {(hiddenCount > 0 || revealed) && (
        <MenuAction value={MENU_ACTION.revealModels}>
          {revealed ? "Hide them again" : `Show ${hiddenCount} hidden`}
        </MenuAction>
      )}
      <MenuAction value={MENU_ACTION.manageModels} divider={hiddenCount === 0 && !revealed}>
        Manage models…
      </MenuAction>
    </>
  )
}
