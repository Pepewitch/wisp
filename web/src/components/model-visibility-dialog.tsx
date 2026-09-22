import { useMemo, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Check, Search } from "@/components/icons"
import { Button, Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { useHarnesses } from "@/hooks/queries"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { failureReason } from "@/lib/api"
import {
  defaultModelFor,
  isUsable,
  loadPreferredModel,
  modelOptionsFor,
  orderHarnesses,
  savePreferredModel,
  unusableReason,
  type ModelChoice,
} from "@/lib/model-choice"
import {
  hiddenCountFor,
  isHidden,
  modelTotals,
  setHarnessHidden,
  toggleModel,
  type HiddenModels,
} from "@/lib/model-visibility"
import { useDaemonRuntime } from "@/lib/runtime"
import type { HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Which models the picker offers — the manager behind the composer's
 * `Manage models…` and Settings' `Manage…`.
 *
 * **It is the dropdown, unfiltered, with a shown/hidden checkmark.** Same
 * grouping, same order, same left slot: in the picker that slot answers "is
 * this chosen", here it answers "is this shown". A separate shape — a
 * two-column rail, a switch per row — would be a second thing to learn for a
 * list you already know how to read. Per §1 it is a checkmark and a dimmed
 * name, never a tinted box: selection in a list is not the accent's job.
 *
 * Nothing is saved and nothing is cancelled (§5g): every toggle is a PATCH,
 * and the footer holds `Done` alone.
 */
export function ModelVisibilityDialog({
  open,
  onOpenChange,
  onPreferredChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The composer keeps the preferred choice in state, so it has to be told
   * when hiding a model clears its star. Absent from Settings, which holds
   * no such state.
   */
  onPreferredChange?: (next: ModelChoice | null) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-nested-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[8vh] left-1/2 z-(--z-nested-modal) w-[min(560px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "overflow-hidden rounded-xl shadow-modal outline-none",
          )}
        >
          <div className="settings-content flex max-h-[84dvh] flex-col">
            <div className="flex shrink-0 items-baseline gap-2.5 border-b border-border px-4 py-3">
              <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">Models</Dialog.Title>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
                Which models the picker offers on this daemon
              </span>
            </div>
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              <ModelVisibilityBody open={open} onPreferredChange={onPreferredChange} />
            </div>
            <Dialog.Close
              render={
                <div className="flex shrink-0 items-center justify-end border-t border-border px-4 py-2.5">
                  <Button size="lg">Done</Button>
                </div>
              }
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ModelVisibilityBody({
  open,
  onPreferredChange,
}: {
  open: boolean
  onPreferredChange?: (next: ModelChoice | null) => void
}) {
  const { connectionId } = useDaemonRuntime()
  const harnessQuery = useHarnesses(open)
  const { hidden, setHidden, error } = useHiddenModels()
  const harnesses = useMemo(() => orderHarnesses(harnessQuery.data ?? []), [harnessQuery.data])

  /**
   * A preference that seeds nothing is a lie, so hiding the starred model
   * clears the star rather than leaving one that can never be offered.
   */
  const apply = (next: HiddenModels) => {
    setHidden(next)
    const preferred = loadPreferredModel(connectionId)
    if (preferred && isHidden(next, preferred.harness, preferred.model)) {
      savePreferredModel(connectionId, null)
      onPreferredChange?.(null)
    }
  }

  return (
    <ModelCuration
      harnesses={harnesses}
      hidden={hidden}
      onApply={apply}
      empty={harnessQuery.isPending ? "Reading harnesses…" : "No harnesses reported by the daemon."}
      error={error == null ? null : failureReason(error)}
    />
  )
}

/** The list itself, with no daemon in it — so `#/gallery` can render one. */
export function ModelCuration({
  harnesses,
  hidden,
  onApply,
  empty,
  error,
  className,
}: {
  harnesses: HarnessInfo[]
  hidden: HiddenModels
  onApply: (next: HiddenModels) => void
  empty: string
  error: string | null
  className?: string
}) {
  const [filter, setFilter] = useState("")
  const totals = modelTotals(harnesses, hidden)
  const needle = filter.trim().toLowerCase()
  const matches = (model: string) => needle === "" || model.toLowerCase().includes(needle)

  return (
    <div className={cn("px-4 py-3.5", className)}>
      <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-surface px-2.5 focus-within:border-accent-dim focus-within:ring-2 focus-within:ring-ring/15">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-faint focus:outline-none"
        />
      </label>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface">
        {harnesses.length === 0 ? (
          <p className="px-3 py-3 text-[11.5px] text-faint">{empty}</p>
        ) : (
          harnesses.map((harness, index) => (
            <HarnessBlock
              key={harness.name}
              harness={harness}
              hidden={hidden}
              matches={matches}
              filtering={needle !== ""}
              first={index === 0}
              onApply={onApply}
            />
          ))
        )}
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
        A harness with nothing shown drops out of the picker. Hiding never changes what a harness can
        run — <code>wisp create --model</code> still works, and a task already on a hidden model keeps
        its model.
      </p>
      <p className="mt-2 text-[11px] text-faint">
        {totals.shown} of {totals.total} shown · applies immediately
      </p>
      {error !== null && (
        <p role="alert" className="mt-2 text-[11.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function HarnessBlock({
  harness,
  hidden,
  matches,
  filtering,
  first,
  onApply,
}: {
  harness: HarnessInfo
  hidden: HiddenModels
  matches: (model: string) => boolean
  filtering: boolean
  first: boolean
  onApply: (next: HiddenModels) => void
}) {
  const options = modelOptionsFor(harness)
  const rows = options.filter(matches)
  // a filter that matched nothing here hides the whole block, rather than
  // leaving an empty harness heading for every harness you did not mean
  if (filtering && rows.length === 0) return null

  const hiddenHere = hiddenCountFor(harness, hidden)
  const shownHere = options.length - hiddenHere
  return (
    <div className={cn(!first && "border-t border-border")}>
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <Eyebrow>{harness.name}</Eyebrow>
        {isUsable(harness) ? (
          <span className="font-mono text-[10.5px] text-faint">
            {shownHere} of {options.length}
          </span>
        ) : (
          <span className="truncate text-[10.5px] text-faint">{unusableReason(harness)}</span>
        )}
        {isUsable(harness) && (
          <span className="ml-auto flex shrink-0 gap-0.5">
            <BulkButton
              disabled={hiddenHere === 0}
              onClick={() => onApply(setHarnessHidden(hidden, harness, false))}
            >
              Show all
            </BulkButton>
            <BulkButton
              disabled={shownHere === 0}
              onClick={() => onApply(setHarnessHidden(hidden, harness, true))}
            >
              Hide all
            </BulkButton>
          </span>
        )}
      </div>
      {isUsable(harness) ? (
        <div className="pb-1">
          {rows.map((model) => (
            <ModelToggle
              key={model}
              harness={harness}
              model={model}
              hidden={isHidden(hidden, harness.name, model)}
              onClick={() => onApply(toggleModel(hidden, harness.name, model))}
            />
          ))}
        </div>
      ) : (
        <p className="px-2.5 pb-2 text-[11px] text-faint">
          Nothing to curate until this harness reports its models.
        </p>
      )}
    </div>
  )
}

function BulkButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-[22px] items-center rounded-md px-2 text-[11px] text-muted-foreground",
        "hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
      )}
    >
      {children}
    </button>
  )
}

function ModelToggle({
  harness,
  model,
  hidden,
  onClick,
}: {
  harness: HarnessInfo
  model: string
  hidden: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={!hidden}
      onClick={onClick}
      // `menu-row` is what gives a coarse pointer its 44px floor (index.css),
      // the same floor the picker's own rows take
      className={cn(
        "menu-row flex h-7 w-full items-center gap-2.5 px-2.5 text-left",
        "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <Check className={cn("size-3 shrink-0", hidden && "opacity-0")} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11.5px]",
          hidden ? "text-faint" : "text-foreground",
        )}
      >
        {model}
      </span>
      {model === defaultModelFor(harness) && (
        <span className="shrink-0 text-[10.5px] text-faint">default</span>
      )}
    </button>
  )
}
