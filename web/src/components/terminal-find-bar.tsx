import { useEffect, useRef, useState, type ReactNode } from "react"
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search"

import { ChevronDown, ChevronUp, Dismiss, Search } from "@/components/icons"
import { Button } from "@/components/primitives"
import { isFindChord } from "@/lib/terminal"
import { cn } from "@/lib/utils"

type Decorations = NonNullable<ISearchOptions["decorations"]>

/**
 * Find in one shell's scrollback.
 *
 * The same bar as find-in-task, anchored to the terminal instead of the
 * transcript, so the two read as one control. It adds the three switches a
 * terminal search is expected to have (case, whole word, regex), because
 * output is exactly where `ERR` versus `error`, or a pattern, matters.
 *
 * Highlights are painted by xterm's search addon, which takes JS colours, so
 * they arrive as `decorations` from the pane's licensed hex block.
 */
export function TerminalFindBar({
  search,
  decorations,
  focusToken,
  apple,
  onClose,
  touch = false,
}: {
  search: SearchAddon
  decorations: Decorations
  /** bumped by every way in (⌘F, the menu), so asking again re-selects the box */
  focusToken: number
  apple: boolean
  onClose: () => void
  touch?: boolean
}) {
  const input = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number }>({ index: -1, count: 0 })
  const invalid = regex && query !== "" && !compiles(query)
  const hit = touch ? "size-11" : undefined

  useEffect(() => {
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    )
    return () => subscription.dispose()
  }, [search])

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusToken])

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive,
    wholeWord,
    regex,
    incremental,
    decorations,
  })

  const run = (direction: 1 | -1, incremental: boolean) => {
    if (query === "" || invalid) {
      search.clearDecorations()
      return
    }
    if (direction === 1) search.findNext(query, options(incremental))
    else search.findPrevious(query, options(false))
  }

  // Typing and flipping a switch re-run the search from where it stands; the
  // arrows and Enter are what move.
  useEffect(() => {
    run(1, true)
    // `run` reads exactly these; listing it would re-search on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, search])

  useEffect(() => () => search.clearDecorations(), [search])

  // what the addon last counted is stale once there is nothing to search for
  const count = query === "" || invalid ? 0 : results.count
  const empty = query !== "" && count === 0
  // -1 with matches means the addon stopped counting at its highlight limit
  const position =
    query === "" ? "" : empty ? "0/0" : results.index < 0 ? `${count}+` : `${results.index + 1}/${count}`

  return (
    <div
      role="search"
      aria-label="Find in shell"
      className={cn(
        "absolute top-1.5 z-(--z-hovercard) flex flex-col gap-1",
        "rounded-lg border border-border-strong bg-popover px-2 py-1.5 shadow-popover",
        touch ? "inset-x-2" : "right-3",
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
          placeholder="Find in shell"
          aria-label="Find in shell"
          aria-invalid={invalid || undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              onClose()
            } else if (event.key === "Enter") {
              event.preventDefault()
              run(event.shiftKey ? -1 : 1, false)
            } else if (isFindChord(event.nativeEvent, apple)) {
              // asking for find while already in it selects what is typed
              event.preventDefault()
              input.current?.select()
            }
          }}
          className={cn(
            "bg-transparent text-foreground outline-none placeholder:text-faint",
            touch ? "h-11 min-w-0 flex-1 text-[13px]" : "h-[22px] w-[148px] text-[12.5px]",
          )}
        />
        <span
          aria-live="polite"
          className={cn(
            "w-[46px] shrink-0 text-right font-mono text-[11px] tabular-nums",
            empty || invalid ? "text-muted-foreground" : "text-faint",
          )}
        >
          {invalid ? "regex?" : position}
        </span>
        <FindSwitch label="Match case" on={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} className={hit}>
          Aa
        </FindSwitch>
        <FindSwitch label="Whole word" on={wholeWord} onToggle={() => setWholeWord((v) => !v)} className={hit}>
          <span className="underline decoration-1 underline-offset-2">ab</span>
        </FindSwitch>
        <FindSwitch label="Regular expression" on={regex} onToggle={() => setRegex((v) => !v)} className={hit}>
          .*
        </FindSwitch>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          className={hit}
          aria-label="Previous match"
          disabled={count === 0}
          onClick={() => run(-1, false)}
        >
          <ChevronUp />
        </Button>
        <Button
          size={touch ? "lg" : "sm"}
          icon
          className={hit}
          aria-label="Next match"
          disabled={count === 0}
          onClick={() => run(1, false)}
        >
          <ChevronDown />
        </Button>
        <Button size={touch ? "lg" : "sm"} icon className={hit} aria-label="Close find" onClick={onClose}>
          <Dismiss />
        </Button>
      </div>
    </div>
  )
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/** An on/off search option. On is a background change, never the accent (§1). */
function FindSwitch({
  label,
  on,
  onToggle,
  className,
  children,
}: {
  label: string
  on: boolean
  onToggle: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <Button
      size="sm"
      icon
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onToggle}
      className={cn("font-mono text-[10.5px]", on && "bg-accent text-foreground", className)}
    >
      {children}
    </Button>
  )
}
