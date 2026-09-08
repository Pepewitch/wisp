import { useState, type ReactNode } from "react"

import { CopyButton } from "@/components/copy-button"
import { POPOVER_SURFACE } from "@/components/primitives"
import { useTick } from "@/hooks/useTick"
import { fromNow, utcIso } from "@/lib/time"
import { cn } from "@/lib/utils"

/**
 * The shape of anything the PERSON said, and the two pieces of chrome that
 * belong to it. It lives outside `conversation.tsx` for the same reason the
 * prompt-bubble specimens do: that file is the transcript, not a warehouse,
 * and it sits at its maintainability cap.
 */

/**
 * When the person sent this bubble.
 *
 * Relative by default, because "5 min ago" is the fact you actually want while
 * a task is live and it stays readable at 10.5px. One click swaps THIS bubble
 * to the exact instant in UTC — the form you paste into a log search — and the
 * mono face says the string is machine-exact (§4). The toggle is per bubble on
 * purpose: asking when one message was sent is a question, not a mode, so it
 * neither persists nor drags every other bubble with it.
 *
 * The relative reading is only true for a second at a time, so it rides the
 * app's one clock; the exact reading never changes and unsubscribes from it.
 */
export function BubbleTimestamp({
  at,
  className,
  /** the gallery renders both readings side by side; the app always starts relative */
  defaultExact = false,
}: {
  at: string
  className?: string
  defaultExact?: boolean
}) {
  const [exact, setExact] = useState(defaultExact)
  const now = useTick(!exact)
  const relative = fromNow(at, now)
  const iso = utcIso(at)
  if (!relative || !iso) return null

  return (
    <button
      type="button"
      data-bubble-timestamp
      onClick={() => setExact((on) => !on)}
      title={exact ? relative : iso}
      className={cn(
        "text-[10.5px] text-faint transition-colors hover:text-muted-foreground",
        exact && "font-mono",
        className,
      )}
    >
      {exact ? iso : relative}
    </button>
  )
}

export function UserMessageCopyButton({ text }: { text: string }) {
  return (
    <CopyButton
      text={text}
      label="Copy user message"
      copiedLabel="Copied user message"
    />
  )
}

/**
 * Every bubble the person wrote is the same shape, and the shape holds their
 * WORDS. Two things hang off it, and they are split by KIND rather than by
 * convenience:
 *
 *  - the **caption** states facts — what this bubble is, and when it was sent.
 *    It sits in the gutter to the left, on the bubble's bottom edge.
 *  - the **actions** act on it — copy, and a queued message's edit and cancel.
 *    They float over the top-right corner, and a pointer reveals them.
 *
 * Both used to be one right-aligned row INSIDE the bubble, under left-aligned
 * prose: two alignments in one box, so the bubble read lopsided, and a line of
 * chrome plus its gap turned the bottom third of a short bubble into padding.
 * Outside, neither costs anything — the bubble is capped at 76%, so the 24%
 * beside it was already empty, and a control nobody is pointing at takes no
 * room at all.
 *
 * `flex-row-reverse` + `flex-wrap` is the whole responsive story, with no
 * breakpoint to keep in sync: reversed, the bubble is the first item and sits
 * at the right edge with the caption to its left; when the two no longer fit —
 * a phone, or the exact UTC instant a click away, which is twice as wide as
 * "5 min ago" — the caption wraps to its own line beneath, still right-aligned.
 * A short message keeps its caption in the gutter even on a phone.
 */
export function PersonBubble({
  caption,
  actions,
  children,
}: {
  /** the FACTS about this bubble: what it is, and when it was sent */
  caption?: ReactNode
  /** the CONTROLS that act on it, floated over its top-right corner */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-row-reverse flex-wrap items-end gap-x-2.5 gap-y-1">
      <div
        className={cn(
          "group/bubble relative max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card",
          "px-3.5 py-2.5 text-[12.5px] leading-relaxed text-foreground/90",
        )}
      >
        {children}
        {actions && (
          <div
            className={cn(
              // Wholly above the top edge rather than straddling it. Straddling
              // reads well until a THREE-control toolbar meets a one-line
              // bubble, and then it sits on the words; 2px clear can never do
              // that, whatever the toolbar grows to hold. Hover still carries
              // across the gap, because the toolbar is a DOM child.
              "absolute right-2 bottom-full mb-0.5 flex items-center gap-0.5 rounded-md p-0.5",
              POPOVER_SURFACE,
              "transition-opacity",
              // hidden until the pointer arrives, and until a keyboard does;
              // on touch there is no hover, so it simply stays (§6b)
              "pointer:opacity-0 pointer:group-hover/bubble:opacity-100 pointer:group-focus-within/bubble:opacity-100",
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {/* one muted register for the whole caption, so a word beside the time
          never has to restate the size it is already written in */}
      {caption && (
        <div className="flex shrink-0 items-center gap-1.5 pb-1 text-[10.5px] text-faint">{caption}</div>
      )}
    </div>
  )
}
