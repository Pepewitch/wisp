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
  className?: string
  /** Controls the menu when a caller must coordinate it with another overlay. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Base.Root open={open} onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}>
      <Base.Trigger
        disabled={disabled}
        aria-label={iconOnly && typeof label === "string" ? label : undefined}
        title={iconOnly && typeof label === "string" ? label : undefined}
        className={cn(
          "flex h-[26px] shrink-0 items-center gap-1.5 rounded-md text-[12px] transition-colors",
          iconOnly ? "w-[26px] justify-center px-0" : "px-2",
          "text-fg-secondary hover:bg-hover hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          "disabled:pointer-events-none disabled:opacity-45",
          "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
          className,
        )}
      >
        {icon}
        {!iconOnly && (
          <>
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 text-faint" />
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
 */
export function MenuAction({ value, children }: { value: string; children: ReactNode }) {
  return (
    <>
      <div className="my-1 h-px bg-border" />
      <Base.RadioItem value={value} className={cn(ROW, "text-muted-foreground")}>
        <span className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </Base.RadioItem>
    </>
  )
}

const ROW = [
  "flex h-[26px] cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] outline-none select-none",
  "text-fg-secondary data-[highlighted]:bg-hover data-[highlighted]:text-foreground",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
].join(" ")

export function MenuItem({
  children,
  onClick,
  disabled,
  hint,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  hint?: ReactNode
}) {
  return (
    <Base.Item className={ROW} onClick={onClick} disabled={disabled}>
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

/** A quiet note inside a menu — a failed probe, a disabled capability. */
export function MenuNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-[11px] leading-normal text-faint">{children}</div>
}
