import { useEffect } from "react"

import type { ProjectSearch } from "@/hooks/useProjectSearch"
import type { UiIntents } from "@/lib/ui-intents"

/**
 * The app's two search chords, installed once on the window.
 *
 * ⌘F is find-in-task and ⌘⇧F is search-across-projects, and both take the key
 * from the browser on purpose: the native find sees only the text the
 * transcript has rendered into the DOM at that instant and cannot say
 * "3 matches in this task, none in the other twelve".
 *
 * This is the palette's rule (§5e) rather than an exception to it: what may
 * not be intercepted above the composer is a BARE key, because the textarea
 * forwards ↑/↓/Home/End/↵ to cmdk and owns everything else it is typing. A
 * ⌘-modified chord is never in that set, so `lib/desktop-zoom.tsx` claims
 * ⌘+/−/0 the same way.
 */
export function useSearchShortcuts(intents: UiIntents, search: ProjectSearch): void {
  const openFind = intents.openFind
  const requestSearch = search.request
  const available = search.available
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key !== "f" && event.key !== "F") return
      event.preventDefault()
      // ⌘F is client-side and always works; ⌘⇧F needs a daemon that answers
      if (event.shiftKey) {
        if (available) requestSearch()
        return
      }
      openFind()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [available, openFind, requestSearch])
}
