import { useEffect, useRef } from "react"

import { Document, Folder, FolderOpen } from "@/components/icons"
import { POPOVER_SURFACE } from "@/components/primitives"
import { MENTION_LIST_ID, mentionOptionId, type MentionRow } from "@/lib/mentions"
import { cn } from "@/lib/utils"

const KIND_ICON = {
  project: FolderOpen,
  here: FolderOpen,
  dir: Folder,
  file: Document,
} as const

/**
 * The `@` list's rows. Not cmdk: the rows are already filtered and ranked by
 * lib/mentions.ts, and the selection is the composer's own state, so the
 * textarea keeps the focus and a row is only ever a pick target. A tap must
 * not take the focus either (a phone would drop its keyboard), hence the
 * `mousedown` that does nothing.
 */
export function MentionListRows({
  rows,
  selected,
  status,
  touch = false,
  onPick,
  onHover,
}: {
  rows: MentionRow[]
  selected: number
  /** a muted line for a folder that is loading or could not be listed */
  status: string | null
  touch?: boolean
  onPick: (row: MentionRow) => void
  onHover?: (index: number) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector(`#${mentionOptionId(selected)}`)?.scrollIntoView?.({ block: "nearest" })
  }, [selected])
  return (
    <div
      ref={list}
      id={MENTION_LIST_ID}
      role="listbox"
      aria-label="Projects and files"
      className="scroll-slim max-h-[40vh] overflow-x-hidden overflow-y-auto"
    >
      {rows.map((row, index) => {
        const Icon = KIND_ICON[row.kind]
        return (
          <div
            key={row.key}
            id={mentionOptionId(index)}
            role="option"
            aria-selected={index === selected}
            data-mention-kind={row.kind}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => onHover?.(index)}
            onClick={() => onPick(row)}
            className={cn(
              "flex cursor-default items-center gap-2.5 rounded-md px-2.5 select-none",
              touch ? "min-h-11" : "h-[26px]",
              index === selected && "bg-accent"
            )}
          >
            <span className="flex shrink-0 items-center text-muted-foreground [&>svg]:size-3.5" aria-hidden>
              <Icon />
            </span>
            <span className="max-w-[60%] shrink-0 truncate font-mono text-[12px] text-foreground">{row.label}</span>
            {row.detail && (
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" title={row.detail}>
                {row.detail}
              </span>
            )}
          </div>
        )
      })}
      {status && <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">{status}</div>}
    </div>
  )
}

/** Floated above the composer exactly where the `/` palette floats. */
export function MentionList(props: Parameters<typeof MentionListRows>[0]) {
  return (
    <div
      data-testid="mention-list"
      className={cn("absolute inset-x-0 bottom-full z-(--z-menu) mb-1.5", POPOVER_SURFACE, "rounded-lg p-1")}
    >
      <MentionListRows {...props} />
    </div>
  )
}
