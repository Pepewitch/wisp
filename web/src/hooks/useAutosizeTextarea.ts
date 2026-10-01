import { useLayoutEffect, type RefObject } from "react"

/**
 * Grows a textarea with its own text instead of scrolling inside a fixed box,
 * and glides to each new height rather than jumping to it.
 *
 * The composer promised this and never did it: `rows` fixes a height, so a
 * long draft scrolled three lines at a time while the `max-h` cap it was given
 * never applied to anything. The cap belongs in CSS (`max-h-*` plus a slim
 * scrollbar); the floor belongs in CSS too (`min-h-*`); so does the motion (a
 * `transition` on height, which reduced motion turns off). This only sets the
 * height between them, measured after every change to `value`, which is also
 * what a paste, a `/` pick and a cleared draft go through.
 *
 * Measuring means letting the box shrink to `auto` for a moment, which would
 * cancel a running transition. So the transition is suspended, the box is
 * measured, put back at the height it was showing (the one mid-glide, if it was
 * gliding), and only then released toward the new height. All of it happens in
 * one layout pass, so nothing is painted in between. While it grows, the new
 * line is revealed by the box rather than scrolled into view inside it.
 *
 * `scrollHeight` is 0 in a headless DOM, so an unmeasurable element keeps
 * whatever CSS gave it rather than collapsing to nothing.
 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string
) {
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const showing = box.getBoundingClientRect().height
    const transition = box.style.transition
    box.style.transition = "none"
    box.style.height = "auto"
    const measured = box.scrollHeight
    if (measured <= 0) {
      box.style.height = ""
      box.style.transition = transition
      return
    }
    if (showing > 0 && Math.abs(showing - measured) > 0.5) {
      box.style.height = `${showing}px`
      void box.offsetHeight // commit the start, so the change below animates
      // growing toward a height that holds the whole draft: reveal, do not scroll.
      // Past the cap the box scrolls for real, and the caret must stay in view.
      const cap = parseFloat(getComputedStyle(box).maxHeight)
      if (measured > showing && !(measured > cap)) box.scrollTop = 0
    }
    box.style.transition = transition
    box.style.height = `${measured}px`
  }, [ref, value])
}
