import { useEffect, useRef } from "react"

import { ChevronRight, Document, Folder, FolderOpen } from "@/components/icons"
import { POPOVER_SURFACE } from "@/components/primitives"
import { MENTION_LIST_ID, mentionOptionId, type MentionRow } from "@/lib/mentions"
import { cn } from "@/lib/utils"

const KIND_ICON = {
  project: FolderOpen,
  dir: Folder,
  file: Document,
} as const

/**
 * The `@` list's rows. Not cmdk: the rows are already filtered and ranked by
 * lib/mentions.ts, and the selection is the composer's own state, so the
 * textarea keeps the focus and a row is only ever a pick target. A tap must
 * not take the focus either (a phone would drop its keyboard), hence the
 * `mousedown` that does nothing.
 *
 * A click inserts the row, like Enter; the chevron on a project or folder
 * opens it, like Tab. The footer names those keys, for a pointer only: a
 * thumb has the chevron.
 */
export function MentionListRows({
  rows,
  selected,
  status,
  touch = false,
  onPick,
  onOpen,
  onHover,
}: {
  rows: MentionRow[]
  selected: number
  /** a muted line for a folder that is loading, could not be listed, or is only partly listed */
  status: string | null
  touch?: boolean
  onPick: (row: MentionRow) => void
  onOpen?: (row: MentionRow) => void
  onHover?: (index: number) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector(`#${mentionOptionId(selected)}`)?.scrollIntoView?.({ block: "nearest" })
  }, [selected])
  const hint = touch || rows.length === 0 ? null : rows.some((row) => row.open) ? "↵ insert · ⇥ open" : "↵ insert"
  return (
    <>
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
                "flex cursor-default items-center gap-2.5 rounded-md pl-2.5 select-none",
                touch ? "min-h-11" : "h-[26px]",
                index === selected && "bg-accent"
              )}
            >
              <span className="flex shrink-0 items-center text-muted-foreground [&>svg]:size-3.5" aria-hidden>
                <Icon />
              </span>
              <span className="max-w-[60%] shrink-0 truncate font-mono text-[12px] text-foreground">{row.label}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" title={row.detail}>
                {row.detail}
              </span>
              {row.open && onOpen && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Open ${row.label}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(row)
                  }}
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&>svg]:size-3.5",
                    touch ? "size-11" : "size-[22px] mr-0.5"
                  )}
                >
                  <ChevronRight />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {(status || hint) && (
        <div className="flex items-center gap-2 px-2.5 pt-1 pb-0.5 text-[10.5px] text-faint">
          {status && <span className="min-w-0 flex-1 truncate">{status}</span>}
          {hint && <span className="ml-auto shrink-0">{hint}</span>}
        </div>
      )}
    </>
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
