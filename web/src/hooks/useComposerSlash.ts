import { useRef, useState, type KeyboardEvent, type RefObject } from "react"

import type { ComposerMentions } from "@/hooks/useComposerMentions"
import { slashTokenAt, type SlashToken } from "@/lib/slash"

/** Forwarded to cmdk while the palette is open; Enter must not send or break a line. */
const PALETTE_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])

export interface ComposerSlash {
  /** the slash token the palette is bound to; null = closed */
  token: SlashToken | null
  /** Recompute what the caret is sitting in — the one place the palette opens. */
  track: (value: string, at: number | null) => void
  /** Escape: close the palette and leave the token alone until the caret leaves it. */
  dismiss: () => void
  /**
   * True when the open palette took the key; the textarea then does nothing
   * else with it. `pickable` is false for a palette showing only its honest
   * footer (a registry that refused, or has not arrived): Escape still closes
   * it, but ↑/↓/↵ belong to the textarea, because there is nothing to pick.
   */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, pickable?: boolean) => boolean
  /**
   * A pick: write `text` over the token, or drop the token alone (`null`) for
   * a local action that never reaches the harness. Returns the token it
   * consumed, so a caller can run that action for the row it belongs to.
   */
  consume: (text: string | null) => SlashToken | null
  /** close it without touching the draft — a send, a task switch */
  close: () => void
}

/**
 * The `/` palette, as state: which slash token the caret is in, which
 * dismissal is still in force, and what a pick writes.
 *
 * Both composers own one of these — the steer box, where a pick may also run
 * a Wisp command or open a tool, and the create composer, where every pick is
 * prompt text. The rules are the same in both, and they are the reason this
 * is one hook rather than two:
 *
 *  - the palette is bound to the slash token under the caret, so moving out
 *    of the token closes it;
 *  - a dismissal is remembered for THAT token, so the next keystroke inside
 *    `/st` does not reopen the list Escape just closed;
 *  - the palette never deletes typed text. Only a PICK consumes the token;
 *  - a `/` word is never an `@` one: only one list is bound at a time, which
 *    is why the `@` list's tracking runs from here.
 */
export function useComposerSlash({
  value,
  setValue,
  caretRef,
  commandRef,
  mentions,
  disabled = false,
}: {
  value: string
  setValue: (value: string) => void
  /** where the caret goes after a pick rewrote the draft (useCaretRestore puts it there) */
  caretRef: RefObject<number | null>
  /** the cmdk root, so the textarea can forward ↑/↓/Home/End/↵ to it */
  commandRef: RefObject<HTMLDivElement | null>
  /** the `@` list sharing this textarea, so the two never bind at once */
  mentions?: ComposerMentions
  /** a read-only composer opens nothing */
  disabled?: boolean
}): ComposerSlash {
  const [token, setToken] = useState<SlashToken | null>(null)
  /**
   * The token start a dismissal applies to. Escape has to mean "leave me
   * alone": without this, the very next keystroke inside `/st` would reopen
   * the list the user just closed.
   */
  const suppressed = useRef<number | null>(null)

  const track = (next: string, at: number | null) => {
    if (disabled) return
    const found = at === null ? null : slashTokenAt(next, at)
    // a `/` word is never an `@` one: only one list is bound at a time
    mentions?.track(next, found ? null : at)
    if (!found) {
      // the token is gone, so the dismissal that suppressed it is spent
      suppressed.current = null
      setToken(null)
      return
    }
    setToken(suppressed.current === found.start ? null : found)
  }

  const dismiss = () => {
    if (token) suppressed.current = token.start
    setToken(null)
  }

  const consume = (text: string | null): SlashToken | null => {
    setToken(null)
    if (!token) return null
    setValue(value.slice(0, token.start) + (text ?? "") + value.slice(token.end))
    caretRef.current = token.start + (text?.length ?? 0)
    // prefilled text stays under the caret, so the palette must not reopen on
    // it; a consumed-and-gone token leaves nothing to suppress
    suppressed.current = text === null ? null : token.start
    return token
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, pickable = true): boolean => {
    if (!token || event.nativeEvent.isComposing) return false
    if (event.key === "Escape") {
      event.preventDefault()
      dismiss()
      return true
    }
    if (!pickable || !PALETTE_KEYS.has(event.key) || event.shiftKey) return false
    event.preventDefault()
    commandRef.current?.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true }))
    return true
  }

  return { token, track, dismiss, onKeyDown, consume, close: () => setToken(null) }
}
