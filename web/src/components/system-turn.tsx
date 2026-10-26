import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { CopyButton } from "@/components/copy-button"
import { BranchRequest, Clock, Console, type FluentIcon } from "@/components/icons"
import { BUBBLE_ACTION, BubbleTimestamp } from "@/components/person-bubble"
import { centerMatch, FIND_REVEAL_EVENT } from "@/lib/find"
import type { SourceLabel } from "@/lib/turn-source"
import type { TurnSource } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The frame of every turn input nobody typed: a subtask report, an autopilot
 * round, a workflow's wake, a harness's own notice. It never wears the
 * person's right-aligned bubble. It sits on the left in a dashed outline, and
 * one quiet line names who wrote it and what it is, so a system event reads
 * as one, not as speech.
 */
export function SystemFrame({
  icon: Icon,
  label,
  at,
  copy,
  data,
  children,
}: {
  icon: FluentIcon
  label: SourceLabel
  at: string
  /** the copy control: it always copies the whole text */
  copy: ReactNode
  /** the block's own data attribute, the handle tests and captures use */
  data: Record<`data-${string}`, string>
  children: ReactNode
}) {
  return (
    <div {...data} className="group/bubble relative rounded-xl rounded-bl-[4px] border border-dashed border-border px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-faint">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-muted-foreground">{label.who}</span>
        {label.parts.map((part, index) => (
          <Fragment key={index}>
            <span aria-hidden>·</span>
            <span>{part}</span>
          </Fragment>
        ))}
        <span aria-hidden>·</span>
        <BubbleTimestamp at={at} />
        <span className="ml-auto pointer:opacity-0 pointer:group-hover/bubble:opacity-100 pointer:group-focus-within/bubble:opacity-100">
          {copy}
        </span>
      </div>
      {children}
    </div>
  )
}

const ICONS: Record<TurnSource["by"], FluentIcon> = {
  autopilot: BranchRequest,
  workflow: Clock,
  harness: Console,
}

/** Past either, the block opens on its first lines only. */
const COLLAPSE_LINES = 4
const COLLAPSE_CHARS = 360

function isLong(text: string): boolean {
  return text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES
}

/**
 * The head of a turn Wisp or the harness started. The text is shown as it was
 * sent; a long one opens on its first lines with Show all, and copy and
 * find-in-task (which opens it on a match) always reach all of it.
 */
export function SystemTurn({ source, label, text, at }: { source: TurnSource; label: SourceLabel; text: string; at: string }) {
  const long = isLong(text)
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // the find match that asked a collapsed block to open, centred again once it has
  const revealing = useRef<Range | null>(null)

  useEffect(() => {
    const node = body.current
    if (!node || !long) return
    // Find's own scroll lands on the four-line box: it runs inside find's
    // effect, where no update can commit first. So the block opens in state,
    // and the layout effect below scrolls to the match once it is open.
    const reveal = (event: Event) => {
      if (node.dataset.systemText !== "collapsed" || !(event instanceof CustomEvent) || !(event.detail instanceof Range)) return
      revealing.current = event.detail
      setOpen(true)
    }
    node.addEventListener(FIND_REVEAL_EVENT, reveal)
    return () => node.removeEventListener(FIND_REVEAL_EVENT, reveal)
  }, [long])

  useLayoutEffect(() => {
    const target = revealing.current
    if (!open || !target) return
    revealing.current = null
    centerMatch(target)
  }, [open])

  return (
    <SystemFrame
      icon={ICONS[source.by]}
      label={label}
      at={at}
      data={{ "data-system-turn": source.by }}
      copy={<CopyButton text={text} label="Copy the message" copiedLabel="Copied the message" className={BUBBLE_ACTION} />}
    >
      <div
        ref={body}
        data-system-text={long ? (open ? "open" : "collapsed") : "short"}
        className={cn(
          "mt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-fg-secondary wrap-anywhere",
          long && !open && "line-clamp-4",
        )}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((on) => !on)}
          className="mt-1 text-[10.5px] text-faint transition-colors hover:text-muted-foreground"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </SystemFrame>
  )
}
