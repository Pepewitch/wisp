import { useEffect, useRef } from "react"

import { ChevronDown, ChevronUp, Dismiss, Search } from "@/components/icons"
import { Button } from "@/components/primitives"
import type { FindState } from "@/hooks/useFindInTask"
import { canPaintMatches } from "@/lib/find"
import { cn } from "@/lib/utils"

/**
 * The find bar. It floats at the TOP of the reading column rather than
 * opening as a dialog: the whole point is to read the transcript while
 * narrowing it, and a modal would cover the thing being searched. Same
 * argument as the composer's palette — a find box is chrome over one pane,
 * not a screen of its own.
 */
export function FindBar({ state, touch = false }: { state: FindState; touch?: boolean }) {
  const { close, count, collapsed, focusToken, position, query, setQuery, step } = state
  const input = useRef<HTMLInputElement | null>(null)
  const empty = query !== "" && count === 0
  // 44px is the FLOOR for a hit box on touch, not the glyph size (§6b), and
  // the shared `lg` control is 32. Layout, so it belongs in a className.
  const hit = touch ? "size-11" : undefined

  // Every way in — ⌘F, the menu, a picked result — asks for the box, so the
  // token rather than mount is what focuses it: pressing ⌘F twice selects
  // what is already typed instead of doing nothing. Token 0 is "nobody asked",
  // which is the gallery specimen: a documentation page takes no focus.
  useEffect(() => {
    if (focusToken === 0) return
    input.current?.focus()
    input.current?.select()
  }, [focusToken])
  return (
    <div
      role="search"
      aria-label="Find in task"
      className={cn(
        "absolute top-2 z-(--z-hovercard) flex flex-col gap-1",
        "rounded-lg border border-border-strong bg-popover px-2 py-1.5 shadow-popover",
        // A phone is 320px wide at its narrowest, which a right-anchored bar
        // of pointer-sized controls overflows. Touch spans the column instead
        // and every control takes its 44px hit box (§6b).
        touch ? "inset-x-2" : "right-4"
      )}
    >
      <div className="flex items-center gap-1.5">
        <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          type="text"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder="Find in task"
          aria-label="Find in task"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              close()
            } else if (event.key === "Enter") {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            }
          }}
          className={cn(
            "bg-transparent text-foreground outline-none placeholder:text-faint",
            touch ? "h-11 min-w-0 flex-1 text-[13px]" : "h-[22px] w-[168px] text-[12.5px]"
          )}
        />
        <span
          aria-live="polite"
          className={cn(
            "w-[52px] shrink-0 text-right font-mono text-[11px] tabular-nums",
            empty ? "text-muted-foreground" : "text-faint"
          )}
        >
          {empty ? "0/0" : position}
        </span>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          className={hit}
          aria-label="Previous match"
          disabled={count === 0}
          onClick={() => step(-1)}
        >
          <ChevronUp />
        </Button>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          className={hit}
          aria-label="Next match"
          disabled={count === 0}
          onClick={() => step(1)}
        >
          <ChevronDown />
        </Button>
        <Button size={touch ? "lg" : "sm"} icon className={hit} aria-label="Close find" onClick={close}>
          <Dismiss />
        </Button>
      </div>
      {/* Honest scope, said only when it can explain a result: a collapsed
          timeline is text the page does not have yet, so it cannot be counted. */}
      {empty && collapsed > 0 && (
        <p className={cn("text-[10.5px] leading-normal text-faint", !touch && "max-w-[300px]")}>
          {collapsed === 1 ? "One turn's activity is" : `${collapsed} turns' activity is`} still collapsed — open it
          to search inside it.
        </p>
      )}
      {!canPaintMatches() && count > 0 && (
        <p className={cn("text-[10.5px] leading-normal text-faint", !touch && "max-w-[300px]")}>
          This webview cannot paint highlights; the arrows still walk the matches.
        </p>
      )}
    </div>
  )
}

/**
 * Gallery specimen (`#/gallery`). A static state, so the entry shows the bar's
 * anatomy — box, counter, the two steppers, dismiss — without a transcript
 * behind it.
 */
export function FindBarSpecimen({
  query = "reducer",
  count = 17,
  position = "3/17",
  collapsed = 0,
}: {
  query?: string
  count?: number
  position?: string
  collapsed?: number
}) {
  return (
    <div className="relative h-[68px]">
      <FindBar
        state={{
          open: true,
          query,
          count,
          position,
          collapsed,
          focusToken: 0,
          revealTurn: null,
          setQuery: () => {},
          step: () => {},
          close: () => {},
        }}
      />
    </div>
  )
}
