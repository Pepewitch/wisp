import { useLayoutEffect, useState, useSyncExternalStore } from "react"

/**
 * The narrowest centre pane that keeps the summary card beside the reading
 * column: the column's 680px measure plus the card's 258px gutter, and room
 * either side for the column to breathe. Narrower than this and the card
 * folds into the top bar's chip (frontend §5n).
 */
export const SUMMARY_CARD_MIN_PANE = 1000

/** The rows of the card that open in place. The lead row (the task's state) has nothing to open. */
export type SummaryRow = "pull-request" | "autopilot" | "subtasks" | "context"

const FOLDED_KEY = "wisp_summary_card_folded"
const OPEN_KEY = "wisp_summary_card_open"
const ROWS: readonly SummaryRow[] = ["pull-request", "autopilot", "subtasks", "context"]

/*
 * Both choices are about this browser's screen, not about a daemon's task, so
 * they are global like the panel's width rather than per connection. One
 * small store serves the card and the chip's popover alike, so a row opened
 * in one is open in the other.
 */
const listeners = new Set<() => void>()
let folded = read(FOLDED_KEY) === "1"
let open = parseOpen(read(OPEN_KEY))

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // blocked or full storage: the choice still holds for this page
  }
}

function parseOpen(raw: string | null): readonly SummaryRow[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]")
    return Array.isArray(value) ? ROWS.filter((row) => value.includes(row)) : []
  } catch {
    return []
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const fn of listeners) fn()
}

/** A person's choice to keep the card folded into the chip, even where it would fit. */
export function useSummaryFolded(): readonly [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => folded)
  return [
    value,
    (next: boolean) => {
      folded = next
      write(FOLDED_KEY, next ? "1" : "0")
      emit()
    },
  ] as const
}

/** Which rows are open: remembered per row, for every task, so a row you keep open stays open as you switch. */
export function useSummaryRows(): { isOpen: (row: SummaryRow) => boolean; set: (row: SummaryRow, value: boolean) => void } {
  const rows = useSyncExternalStore(subscribe, () => open)
  return {
    isOpen: (row) => rows.includes(row),
    set: (row, value) => {
      open = value ? ROWS.filter((at) => at === row || open.includes(at)) : open.filter((at) => at !== row)
      write(OPEN_KEY, JSON.stringify(open))
      emit()
    },
  }
}

/**
 * Whether `pane` is wide enough for the card. Measured on the pane itself
 * (a ResizeObserver), never the window: opening a tool narrows the centre
 * without the window changing at all, and that is the common way to cross
 * the line. Read once before paint, so a wide pane never flashes the chip.
 * While the tool panel glides, `settling` is the width the pane will land
 * at, and it decides: the pane passing the line mid-glide changes nothing.
 */
export function usePaneFitsCard(pane: HTMLElement | null, settling: number | null = null): boolean {
  const [fits, setFits] = useState(false)
  useLayoutEffect(() => {
    if (!pane) return
    const measure = (width: number) => setFits(width >= SUMMARY_CARD_MIN_PANE)
    measure(pane.getBoundingClientRect().width)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) measure(entry.contentRect.width)
    })
    observer.observe(pane)
    return () => observer.disconnect()
  }, [pane])
  return settling === null ? fits : settling >= SUMMARY_CARD_MIN_PANE
}

/**
 * Where the shell draws the summary: the card beside the reading column while
 * the centre pane has room for both and nobody folded it, the top bar's chip
 * otherwise, nothing while no task is shown. `setPane` takes the pane;
 * `setSettling` the pane's width at the end of a tool panel's glide, and
 * null once it lands (`Shell`'s `onCentreSettling`).
 */
export function useSummaryPlacement(shown: boolean) {
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const [settling, setSettling] = useState<number | null>(null)
  const roomy = usePaneFitsCard(pane, settling)
  const [folded] = useSummaryFolded()
  const placement: "card" | "chip" | null = !shown ? null : roomy && !folded ? "card" : "chip"
  return { setPane, roomy, placement, setSettling }
}

/** Test seam: forget the stored choices and reread them. */
export function resetSummaryCardStore(): void {
  folded = read(FOLDED_KEY) === "1"
  open = parseOpen(read(OPEN_KEY))
  emit()
}
