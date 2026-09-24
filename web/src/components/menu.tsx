import type { ReactNode } from "react"
import { Menu as Base } from "@base-ui/react/menu"

import { Check, ChevronDown } from "@/components/icons"
import { POPOVER_SURFACE } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * The app's one dropdown. base-ui owns focus, typeahead and collision; this
 * file owns the look, so a menu never gets restyled ad hoc at a call site.
 *
 * Selection inside a menu is a checkmark plus `bg-hover`, not the accent — the
 * accent means live or primary action, never "which one is chosen"
 * (CONVENTIONS §1).
 */
export function Menu({
  label,
  icon,
  children,
  align = "start",
  side = "bottom",
  disabled = false,
  iconOnly = false,
  touch = false,
  "aria-label": ariaLabel,
  className,
  open,
  onOpenChange,
}: {
  /** the trigger's text; with `iconOnly` it becomes the accessible name instead */
  label: ReactNode
  icon?: ReactNode
  children: ReactNode
  align?: "start" | "center" | "end"
  /** Defaults to below the trigger — base-ui flips it when there is no room. */
  side?: "top" | "bottom"
  disabled?: boolean
  /** square glyph trigger, no text and no chevron — for an overflow menu */
  iconOnly?: boolean
  /**
   * Thumb sizing: the trigger fills the 44px touch floor (§6b) and answers a
   * press with `active:`, because a finger reveals nothing by hovering. The
   * one place a menu trigger changes size, so no call site rolls its own.
   */
  touch?: boolean
  /**
   * The trigger's accessible name when its own text is the VALUE rather than
   * the field — a settings row's `Dark` needs to announce itself as `Theme`.
   * `iconOnly` keeps naming itself from `label`.
   */
  "aria-label"?: string
  className?: string
  /** Controls the menu when a caller must coordinate it with another overlay. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const name = ariaLabel ?? (iconOnly && typeof label === "string" ? label : undefined)
  return (
    <Base.Root open={open} onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}>
      <Base.Trigger
        disabled={disabled}
        aria-label={name}
        // a tooltip earns its place on a glyph; a labelled trigger already
        // shows its value, so `Theme` hovering over `Dark` is noise
        title={iconOnly && typeof label === "string" ? label : undefined}
        className={cn(
          "flex shrink-0 items-center rounded-md transition-colors",
          touch ? "h-11 gap-1 text-[13px] active:bg-hover" : "h-[26px] gap-1.5 text-[12px]",
          iconOnly ? cn("justify-center px-0", touch ? "w-11" : "w-[26px]") : "px-2",
          "text-fg-secondary hover:bg-hover hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          "disabled:pointer-events-none disabled:opacity-45",
          "[&>svg]:shrink-0 [&>svg]:text-muted-foreground",
          touch ? "[&>svg]:size-[17px]" : "[&>svg]:size-3.5",
          className,
        )}
      >
        {icon}
        {!iconOnly && (
          <>
            <span className="truncate">{label}</span>
            {/* wrapped, so the trigger's own `[&>svg]` sizing lands on the
                leading glyph alone: the chevron is a mark, not a second icon */}
            <span className="flex shrink-0 items-center">
              <ChevronDown className="size-3 text-faint" />
            </span>
          </>
        )}
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={6} collisionPadding={12} className="z-(--z-menu)">
          <Base.Popup
            className={cn(
              "scroll-slim max-h-[min(24rem,var(--available-height))] min-w-[13rem] overflow-y-auto",
              POPOVER_SURFACE,
              "rounded-lg p-1 outline-none",
            )}
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}

/**
 * A labelled block inside a menu — one per harness in the model picker.
 * `hint` carries the group's own state (a default, or why it is unusable).
 */
export function MenuGroup({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <Base.Group className="py-0.5 first:pt-0">
      <Base.GroupLabel className="flex items-baseline gap-2 px-2 pt-1.5 pb-1">
        <span className="eyebrow">{label}</span>
        {hint && <span className="truncate text-[10.5px] normal-case text-faint">{hint}</span>}
      </Base.GroupLabel>
      {children}
    </Base.Group>
  )
}

/**
 * A footer action inside a RADIO menu.
 *
 * It is a `RadioItem`, not an `Item`, on purpose: base-ui will not register a
 * plain Item that sits alongside a RadioGroup — arrow keys skip it and its
 * onClick never fires. Actions therefore ride as sentinel VALUES, which the
 * caller recognises in onValueChange. A sentinel never equals real state, so
 * it never renders a checkmark.
 *
 * The rule above the actions is what separates them from the CHOICES, so a
 * run of them draws exactly one: `divider={false}` on every action after the
 * first. Three rules through a three-row footer would read as three groups.
 */
export function MenuAction({
  value,
  children,
  disabled = false,
  divider = true,
}: {
  value: string
  children: ReactNode
  disabled?: boolean
  /** False for an action that follows another — the group already has its rule. */
  divider?: boolean
}) {
  return (
    <>
      {divider && <div className="my-1 h-px bg-border" />}
      <Base.RadioItem value={value} disabled={disabled} className={cn(ROW, "text-muted-foreground")}>
        <span className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </Base.RadioItem>
    </>
  )
}

const ROW = [
  // `menu-row` is where a coarse pointer takes the 44px floor (index.css)
  "menu-row flex h-[26px] cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] outline-none select-none",
  "text-fg-secondary data-[highlighted]:bg-hover data-[highlighted]:text-foreground",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
].join(" ")

export function MenuItem({
  children,
  onClick,
  disabled,
  hint,
  keepOpen = false,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  hint?: ReactNode
  /** stay open, so the row's own outcome (a refusal, a new state) can be read in place */
  keepOpen?: boolean
}) {
  return (
    <Base.Item className={ROW} onClick={onClick} disabled={disabled} closeOnClick={!keepOpen}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[10.5px] text-faint">{hint}</span>}
    </Base.Item>
  )
}

/** A single-choice set. `value` is the encoded selection, not a display label. */
export function MenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <Base.RadioGroup value={value} onValueChange={(v) => onValueChange(String(v))}>
      {children}
    </Base.RadioGroup>
  )
}

export function MenuRadioItem({
  value,
  children,
  hint,
  className,
}: {
  value: string
  children: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <Base.RadioItem value={value} className={cn(ROW, "data-[checked]:text-foreground", className)}>
      <Base.RadioItemIndicator className="flex size-3 shrink-0 items-center justify-center" keepMounted>
        <Check className="size-3 opacity-0 data-[checked]:opacity-100 [[data-checked]_&]:opacity-100" />
      </Base.RadioItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 font-mono text-[10.5px] text-faint">{hint}</span>}
    </Base.RadioItem>
  )
}

/**
 * An on/off switch inside a menu. It keeps the menu open, so a toggle can be
 * read back before the menu is dismissed.
 *
 * It ends in a small switch rather than starting with a checkmark. A radio
 * row's empty checkmark slot is explained by its checked neighbour or the
 * menu's header. These rows share a menu with actions and have neither, so an
 * unticked "Auto-merge" would read as a command. The switch shows off as
 * plainly as on, and leaves the label aligned with the actions above it. It is
 * neutral (foreground when on), never the accent.
 */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <Base.CheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      className={cn(ROW, "data-[checked]:text-foreground")}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* the row is the checkbox (role and aria-checked); the switch only draws its state */}
      <span aria-hidden className="relative h-3.5 w-6 shrink-0 rounded-full bg-border-strong transition-colors [[data-checked]_&]:bg-foreground motion-reduce:transition-none">
        <span className="absolute top-0.5 left-0.5 size-2.5 rounded-full bg-muted-foreground transition-[translate,background-color] [[data-checked]_&]:translate-x-2.5 [[data-checked]_&]:bg-background motion-reduce:transition-none" />
      </span>
    </Base.CheckboxItem>
  )
}

/** The rule between groups of unrelated verbs. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />
}

/** A quiet note inside a menu — a failed probe, a disabled capability. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-[11px] leading-normal text-faint">{children}</div>
}
