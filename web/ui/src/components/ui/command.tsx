import { Command as CommandPrimitive } from "cmdk"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * The only cmdk this app mounts: the filter engine and keyboard list behind the
 * `/` palette (slash-palette.tsx). Just the parts that palette uses — there is
 * no dialog wrapper, because the palette is not a modal: it floats above the
 * composer and the textarea stays the real input.
 *
 * Every class here is this app's language (CONVENTIONS §1, §4, the 26px row),
 * not shadcn's defaults: a 26px row, mono command names, muted hints, and
 * selection as a background change — cmdk sets `data-selected` on the
 * highlighted item and `bg-accent` is what selection looks like everywhere else.
 */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive className={cn("flex w-full flex-col", className)} {...props} />
}

/**
 * The filter driver, never seen and never focused.
 *
 * cmdk filters against its own input, and the input a person types into is the
 * composer's textarea — so this one is mounted `sr-only` with `tabIndex={-1}`,
 * fed the slash token's query, and left alone. Removing it would remove
 * filtering; making it visible would give the palette a second input.
 */
export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return <CommandPrimitive.Input className={cn("sr-only", className)} tabIndex={-1} {...props} />
}

/** Capped at 40vh so a long list never eats the conversation above it. */
export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("scroll-slim max-h-[40vh] overflow-y-auto overflow-x-hidden outline-none", className)}
      {...props}
    />
  )
}

/** cmdk renders this only when nothing matched. One muted line, no illustration. */
export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn("px-2.5 py-2 text-[11.5px] text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * A tier. The heading is passed in as an `Eyebrow` node — the one uppercase
 * register a group is allowed — and cmdk owns the element it lands in, so the
 * padding is applied through its `cmdk-group-heading` hook.
 */
export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-6 [&_[cmdk-group-heading]]:items-center",
        "[&_[cmdk-group-heading]]:px-2.5",
        className,
      )}
      {...props}
    />
  )
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-md px-2.5 outline-none select-none",
        "data-selected:bg-accent",
        className,
      )}
      {...props}
    />
  )
}
