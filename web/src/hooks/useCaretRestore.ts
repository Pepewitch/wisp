import { useEffect, type RefObject } from "react"

/**
 * Put the caret where a pick that rewrote the draft asked for it, after that
 * render. Shared by both composers: the `@` list and the `/` palette both
 * write the draft and then name the position the caret belongs in, and a
 * textarea's selection survives neither a value change nor a re-render.
 */
export function useCaretRestore(
  boxRef: RefObject<HTMLTextAreaElement | null>,
  caretRef: RefObject<number | null>,
): void {
  useEffect(() => {
    const pos = caretRef.current
    if (pos === null) return
    caretRef.current = null
    boxRef.current?.focus()
    boxRef.current?.setSelectionRange(pos, pos)
  })
}
