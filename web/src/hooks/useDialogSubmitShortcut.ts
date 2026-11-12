import { useEffect, useRef } from "react"

/**
 * ⌘↵ belongs to the DIALOG, not to whichever element has focus.
 *
 * Focus legitimately sits outside the composer's <form> at times — base-ui
 * parks it on the popup, which is the form's PARENT, so a handler on the form
 * never sees the event and the shortcut silently dies. This listener lives
 * exactly as long as the open dialog, and the dialog is modal, so it competes
 * with nothing. (The steer box's palette bug was the mirror image of this: a
 * document handler that outlived its owner.)
 *
 * `paused` is for a nested dialog of its own — the suffix-prompt editor —
 * whose ⌘↵ must never leak into the composer underneath it.
 *
 * A key the composer already answered is NOT the dialog's. `preventDefault`
 * does not stop propagation, so without the `defaultPrevented` check a ⌘↵
 * that picked a row in the `/` palette — or that an open `@` list swallowed
 * on purpose — would reach this listener too and create the task from the
 * draft as it stood BEFORE the pick.
 *
 * The submit closure is refreshed after every render with no dep array:
 * writing a ref DURING render is a purity violation, and the whole point of
 * the ref is that the listener reads the latest closure without re-binding
 * once per keystroke.
 */
export function useDialogSubmitShortcut(submit: () => void, paused = false): void {
  const latest = useRef(submit)
  useEffect(() => {
    latest.current = submit
  })
  useEffect(() => {
    if (paused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        latest.current()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [paused])
}
