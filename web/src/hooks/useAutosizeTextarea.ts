import { useEffect, type RefObject } from "react"

/**
 * Grows a textarea with its own text instead of scrolling inside a fixed box.
 *
 * The composer promised this and never did it: `rows` fixes a height, so a
 * long draft scrolled three lines at a time while the `max-h` cap it was given
 * never applied to anything. The cap belongs in CSS (`max-h-*` plus a slim
 * scrollbar); the floor belongs in CSS too (`min-h-*`). This only sets the
 * height between them, measured after every change to `value`, which is also
 * what a paste, a `/` pick and a cleared draft go through.
 *
 * `scrollHeight` is 0 in a headless DOM, so an unmeasurable element keeps
 * whatever CSS gave it rather than collapsing to nothing.
 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string
) {
  useEffect(() => {
    const box = ref.current
    if (!box) return
    box.style.height = "auto"
    const measured = box.scrollHeight
    box.style.height = measured > 0 ? `${measured}px` : ""
  }, [ref, value])
}
