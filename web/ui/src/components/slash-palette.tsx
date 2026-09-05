import type { Ref } from "react"
import { defaultFilter } from "cmdk"

import { Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { slashValue, type SlashEntry, type SlashGroup } from "@/lib/slash"
import { cn } from "@/lib/utils"

/**
 * The `/` palette (A2). A real picker: type `/`, arrow through the list, Enter
 * to choose — the textarea below stays the input the whole time.
 *
 * Grouped by tier, and ONLY the tier that costs a model turn says so (Q6, and
 * §5c's "only what is news is marked"). A tier with no entries renders no
 * group at all: a task whose skills haven't loaded (or whose daemon refused
 * while a turn runs) has no Skills heading, and a harness whose adapter
 * declares no out-of-turn reads is absent Tier 2 the same way rather than as
 * an empty promise.
 */
export function SlashPaletteList({
  groups,
  query,
  onPick,
  commandRef,
  touch = false,
  selectedValue,
}: {
  groups: SlashGroup[]
  /** the slash token's text after the `/`; cmdk does the filtering */
  query: string
  /** the picked ENTRY, not just its name — Tier 2 needs its probe identity */
  onPick: (entry: SlashEntry) => void
  /** the cmdk root, so the textarea can forward ↑/↓/Home/End/↵ to it */
  commandRef?: Ref<HTMLDivElement>
  touch?: boolean
  /** Gallery-only controlled selection; an empty value prevents mount-time scrolling. */
  selectedValue?: string
}) {
  const shown = groups.filter((group) => group.entries.length > 0)
  return (
    <Command
      ref={commandRef}
      label="Slash commands"
      loop
      // cmdk gives extremely weak subsequence matches a positive score
      // (`status` matches `usage` at ~0.004). Keep a small relevance floor
      // while preserving useful shorthand such as `ctx` → `context`.
      filter={(value, search, keywords) => {
        const score = defaultFilter(value, search, keywords)
        return score >= 0.05 ? score : 0
      }}
      {...(selectedValue === undefined ? {} : { value: selectedValue, onValueChange: () => {} })}
    >
      <CommandInput value={query} onValueChange={() => {}} aria-hidden />
      <CommandList>
        <CommandEmpty>No matching command</CommandEmpty>
        {shown.map((group) => (
          <CommandGroup key={group.label} heading={<Eyebrow>{group.label}</Eyebrow>}>
            {group.entries.map((entry) => (
              <CommandItem
                key={slashValue(entry)}
                value={slashValue(entry)}
                keywords={entry.keywords}
                onSelect={() => onPick(entry)}
                data-testid={`slash-${slashValue(entry)}`}
                className={touch ? "min-h-11" : "h-[26px]"}
              >
                {/* a prompt-invoke skill (codex) shows its bare name — a
                    `/name` here would imply a headless invocation SP2 proved
                    codex does not have */}
                <span className="shrink-0 font-mono text-[12px] text-foreground">
                  {entry.prefill && !entry.prefill.startsWith("/") ? entry.name : `/${entry.name}`}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{entry.hint}</span>
                {/* cost is marked per-entry first (A5: compact is the one
                    costing entry inside the free-reads group, and droid's
                    "costs tokens" is not codex's "runs a turn"), then the
                    ONE marked tier: picking this spends tokens */}
                {(entry.costLabel ?? (group.costsTurn ? "runs a turn" : null)) && (
                  <span className="shrink-0 text-[10.5px] text-faint">
                    {entry.costLabel ?? "runs a turn"}
                  </span>
                )}
              </CommandItem>
            ))}
            {/* A4's honesty row: what the list cannot show, said out loud —
                not a selectable item, just a muted confession under the group */}
            {group.footer && (
              <div
                title={group.footerTitle ?? group.footer}
                className="truncate px-2 py-1 text-[10.5px] text-faint select-none"
              >
                {group.footer}
              </div>
            )}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}

/**
 * The list, floated above the composer. Not portalled and not a modal — it is
 * part of the composer, so it sits in the composer's own stacking context and
 * names a layer, because an in-pane `z-10` (the conversation's scroll fade)
 * would otherwise paint over it.
 */
export function SlashPalette(props: Parameters<typeof SlashPaletteList>[0]) {
  return (
    <div
      data-testid="slash-palette"
      className={cn("absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5", POPOVER_SURFACE, "rounded-lg p-1")}
    >
      <SlashPaletteList {...props} />
    </div>
  )
}
