import { Flash } from "@/components/icons"
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
  const label = value ? "Fast mode on" : "Fast mode"
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={value}
      title={value ? "Fast mode on — the same model, in the harness's faster lane" : "Fast mode off — standard speed"}
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
      <Flash />
      {value && <span className="truncate">Fast</span>}
    </button>
  )
}
