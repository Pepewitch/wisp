import type { ReactNode } from "react"

import { Brief, Flash } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * Fast mode: the harness's faster lane for the SAME model, one press.
 *
 * A toggle rather than a menu because the daemon reports a capability, not a
 * vocabulary — `hasFastMode` is a boolean and the tier values stay in the
 * adapter, so there is nothing here to pick from. Harnesses whose "fast" is a
 * separate model id instead (droid's `gpt-5.6-sol-fast`) report no fast mode
 * and render no button: those ids are already in the model menu, and a toggle
 * that silently rewrote the chosen model would make the model chip lie.
 *
 * OFF is a real state, not an absence: the daemon sends the harness's standard
 * tier explicitly, so an unlit bolt cannot mean "whatever your CLI's own config
 * file happens to pin".
 *
 * Shaped like a Menu trigger (same heights, same hover and focus language) so
 * it sits in the composer's control row without a bespoke look, and it says ON
 * with the menus' own "chosen" styling rather than the accent, which belongs to
 * live and primary actions.
 */
export function FastModeToggle({
  value,
  disabled = false,
  touch = false,
  onChange,
}: {
  value: boolean
  disabled?: boolean
  /** Thumb sizing, matching Menu's 44px touch floor. */
  touch?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <GlyphToggle
      icon={<Flash />}
      name="Fast mode"
      onText="Fast"
      title={value ? "Fast mode on — the same model, in the harness's faster lane" : "Fast mode off — standard speed"}
      value={value}
      disabled={disabled}
      touch={touch}
      onChange={onChange}
    />
  )
}

/**
 * Task briefs, chosen before the first turn: the same glyph-until-chosen shape
 * as fast mode (§5c-ii), because it too changes what every turn is sent — one
 * short line asking the agent for a brief. Starts at the chosen model's
 * default from the Models modal, which is on unless switched off there.
 */
export function BriefToggle({ value, touch = false, onChange }: { value: boolean; touch?: boolean; onChange: (value: boolean) => void }) {
  return (
    <GlyphToggle
      icon={<Brief />}
      name="Task brief"
      onText="Brief"
      title={value
        ? "Task brief on — each turn ends with the agent saving a short report"
        : "Task brief off — no report is asked for"}
      value={value}
      touch={touch}
      onChange={onChange}
    />
  )
}

/**
 * The control-bar toggle both of these are: shaped like a Menu trigger (same
 * heights, same hover and focus language), its glyph alone while off and its
 * value spelled out while on, and ON said with the menus' own "chosen"
 * styling rather than the accent.
 */
function GlyphToggle({
  icon,
  name,
  onText,
  title,
  value,
  disabled = false,
  touch = false,
  onChange,
}: {
  icon: ReactNode
  name: string
  onText: string
  title: string
  value: boolean
  disabled?: boolean
  touch?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-label={value ? `${name} on` : name}
      aria-pressed={value}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "flex shrink-0 items-center rounded-md transition-colors",
        touch ? "h-11 gap-1 text-[13px] active:bg-hover" : "h-[26px] gap-1.5 text-[12px]",
        value ? "px-2" : cn("justify-center px-0", touch ? "w-11" : "w-[26px]"),
        "text-fg-secondary hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
        "[&>svg]:shrink-0",
        touch ? "[&>svg]:size-[17px]" : "[&>svg]:size-3.5",
        value ? "bg-hover text-foreground [&>svg]:text-foreground" : "[&>svg]:text-muted-foreground",
      )}
    >
      {icon}
      {value && <span className="truncate">{onText}</span>}
    </button>
  )
}
