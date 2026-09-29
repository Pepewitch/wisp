import { Queue, QueueFilled } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * Hold the next send for the next turn instead of steering it into this one.
 *
 * Only offered while a turn runs, and only for the one send it is armed for:
 * the composer turns it off again after every send, so a forgotten toggle
 * can never quietly hold every later message back.
 *
 * Glyph only, in both states, beside the send button it changes: the running
 * note above the composer already says in words what the send will do, and
 * the filled glyph is the "on" the reader looks for. Its title and pressed
 * state carry the same for a screen reader and a hover.
 */
export function QueueToggle({
  value,
  disabled = false,
  touch = false,
  onChange,
}: {
  value: boolean
  disabled?: boolean
  touch?: boolean
  onChange: (value: boolean) => void
}) {
  const Icon = value ? QueueFilled : Queue
  return (
    <button
      type="button"
      aria-label="Queue for the next turn"
      aria-pressed={value}
      title={value ? "Queued: send waits for the next turn" : "Queue: hold the next send for the next turn"}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md transition-colors",
        touch ? "size-11 active:bg-hover" : "size-[26px]",
        "hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
        value ? "bg-hover text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className={touch ? "size-[18px]" : "size-4"} />
    </button>
  )
}
