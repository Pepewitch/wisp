import { useState } from "react"

import { Branch } from "@/components/icons"
import { Menu, MenuAction, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { MENU_ACTION } from "@/lib/menu-actions"
import { cn } from "@/lib/utils"

/**
 * A one-off base for THIS task, when the project's usual one is not what you
 * want — continuing on top of a feature branch, or targeting a release line.
 *
 * Empty is not a blank to fill in: it means the project decides, which is
 * `origin/HEAD` unless its settings say otherwise. So the resting label says
 * "Base" rather than a resolved ref, because printing "origin/main" here
 * would be a guess the composer cannot verify — the daemon resolves it at
 * creation, after fetching, and the task then records what it actually got.
 */
export function BasePicker({
  base,
  onChange,
  onRestoreComposer,
}: {
  base: string
  onChange: (value: string) => void
  onRestoreComposer: () => void
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <input
        autoFocus
        value={base}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return
          event.preventDefault()
          // Escape abandons the override rather than keeping a half-typed ref
          // that would fail resolution at creation time.
          if (event.key === "Escape") onChange("")
          setEditing(false)
          onRestoreComposer()
        }}
        placeholder="origin/develop"
        aria-label="Base branch"
        className={cn(
          "h-[26px] w-44 rounded-md border border-accent-dim bg-surface px-2 font-mono text-[11.5px]",
          "text-foreground placeholder:text-faint focus:ring-2 focus-visible:ring-ring/15 focus:outline-none",
        )}
      />
    )
  }

  return (
    <Menu icon={<Branch />} label={base.trim() === "" ? "Base" : base.trim()}>
      <MenuRadioGroup
        value={base.trim() === "" ? "" : MENU_ACTION.custom}
        onValueChange={(value) => (value === MENU_ACTION.custom ? setEditing(true) : onChange(""))}
      >
        <MenuRadioItem value="" hint="default">
          Project default
        </MenuRadioItem>
        <MenuAction value={MENU_ACTION.custom}>Start from another ref…</MenuAction>
      </MenuRadioGroup>
      <MenuNote>
        {base.trim() === ""
          ? "Forks from this project's base branch — the remote's default unless the project's settings name another one. Wisp fetches first, so it starts from what origin has now, not from your local checkout."
          : `Forks from ${base.trim()} instead of this project's base branch.`}
      </MenuNote>
    </Menu>
  )
}
