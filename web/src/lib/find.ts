/**
 * Find-in-task: exact text over the transcript that is ON SCREEN.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * **The DOM is the haystack, not the task JSON.** `GET /api/tasks/:id` gives
 * the client every turn's prompt and result, but a settled turn's activity
 * timeline is fetched on demand and dropped again (the scroll contract, §5),
 * so a data-model search would count matches nobody can see and miss the ones
 * inside a timeline someone just opened. Searching the rendered text is
 * therefore both simpler and strictly more truthful: it finds exactly what is
 * on the page, and it grows as the reader opens more of the turn. The find bar
 * says so when a turn is still collapsed.
 *
 * **Highlighting never touches the DOM.** Wrapping matches in `<mark>` would
 * mean mutating a tree React owns, mid-stream, while a live turn appends to it.
 * The CSS Custom Highlight API paints ranges instead — no nodes move, so the
 * reducer, the pin threshold and `overflow-anchor` all keep working. Where the
 * API is missing the bar still counts and still scrolls; it just cannot paint,
 * which is a quieter failure than a rebuilt transcript.
 */

/** Registered in index.css as ::highlight(...) — both names live there too. */
export const FIND_HIGHLIGHT = "wisp-find"
export const FIND_HIGHLIGHT_CURRENT = "wisp-find-current"

interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

interface HighlightApi {
  highlights?: HighlightRegistry
}

interface HighlightConstructor {
  new (...ranges: Range[]): unknown
}

function registry(): HighlightRegistry | null {
  const api = (globalThis as { CSS?: HighlightApi }).CSS
  const highlights = api?.highlights
  const constructor = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  return highlights && constructor ? highlights : null
}

/** False in a webview too old for ::highlight(); counting still works. */
export function canPaintMatches(): boolean {
  return registry() !== null
}

interface TextIndex {
  text: string
  /** every text node in document order, with where it starts in `text` */
  nodes: { node: Text; start: number }[]
}

/** One flat string for the subtree, so a match may span element boundaries. */
export function indexText(root: Node): TextIndex {
  const nodes: TextIndex["nodes"] = []
  let text = ""
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? ""
    if (value === "") continue
    nodes.push({ node: node as Text, start: text.length })
    text += value
  }
  return { text, nodes }
}

/**
 * The node and offset a flat position lands on.
 *
 * A position on a node boundary belongs to two nodes, and which one is chosen
 * is not cosmetic: a match anchored to the END of the previous node scrolls
 * the previous element into view, so a hit at the head of a bubble would
 * reveal the row above it. `bias` picks the node the match is actually IN.
 */
function locate(
  index: TextIndex,
  position: number,
  bias: "start" | "end"
): { node: Text; offset: number } | null {
  let low = 0
  let high = index.nodes.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const entry = index.nodes[middle]!
    const end = entry.start + (entry.node.nodeValue ?? "").length
    if (position < entry.start) high = middle - 1
    else if (position > end) low = middle + 1
    else {
      const next = index.nodes[middle + 1]
      if (bias === "start" && position === end && next) return { node: next.node, offset: 0 }
      const previous = index.nodes[middle - 1]
      if (bias === "end" && position === entry.start && previous) {
        return { node: previous.node, offset: (previous.node.nodeValue ?? "").length }
      }
      return { node: entry.node, offset: position - entry.start }
    }
  }
  return null
}

/**
 * Every case-insensitive occurrence of `needle`, in reading order. Matches do
 * not overlap: the next search starts after the one just found, which is what
 * makes the counter agree with pressing Enter that many times.
 */
export function findRanges(root: Node, needle: string): Range[] {
  if (needle === "") return []
  const index = indexText(root)
  const haystack = index.text.toLowerCase()
  const target = needle.toLowerCase()
  const ranges: Range[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(target, from)
    if (at === -1) return ranges
    from = at + target.length
    const start = locate(index, at, "start")
    const end = locate(index, from, "end")
    if (!start || !end) continue
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    ranges.push(range)
  }
}

/**
 * Paint the hits. The current one is a SECOND highlight over the same range
 * rather than a different list, so the two ::highlight rules stack in the
 * order index.css declares and the current match never loses its underlay.
 */
export function paintMatches(ranges: Range[], current: number): void {
  const highlights = registry()
  if (!highlights) return
  const Constructor = (globalThis as { Highlight?: HighlightConstructor }).Highlight!
  if (ranges.length === 0) {
    clearMatches()
    return
  }
  highlights.set(FIND_HIGHLIGHT, new Constructor(...ranges))
  const active = ranges[current]
  if (active) highlights.set(FIND_HIGHLIGHT_CURRENT, new Constructor(active))
  else highlights.delete(FIND_HIGHLIGHT_CURRENT)
}

export function clearMatches(): void {
  const highlights = registry()
  if (!highlights) return
  highlights.delete(FIND_HIGHLIGHT)
  highlights.delete(FIND_HIGHLIGHT_CURRENT)
}

/** Bring a match into the reading column. Centred: a match at the very edge reads as absent. */
export function revealMatch(range: Range | undefined): void {
  const node = range?.startContainer
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null)
  element?.scrollIntoView?.({ block: "center", inline: "nearest" })
}

/** `1/12`, or nothing to say yet. A zero count is the bar's own empty state. */
export function matchPosition(count: number, current: number): string {
  return count === 0 ? "" : `${current + 1}/${count}`
}

/**
 * How much of the daemon's lead a sidebar row may keep. The pane is ~260px
 * wide and the row truncates on the right, so a snippet that opened with the
 * daemon's full 32-character run-up would push the MATCH — the one part of
 * the line worth reading — off the end of a row that looks perfectly fine.
 */
const MAX_SNIPPET_LEAD = 14

/**
 * A daemon snippet split for rendering: the daemon located the match, so the
 * client never re-searches a string it was handed a position for. The lead is
 * trimmed on a word boundary where there is one, so the hit sits near the
 * left edge of a row that clips on the right.
 */
export function snippetParts(
  text: string,
  offset: number,
  length: number,
  maxLead = MAX_SNIPPET_LEAD
): { before: string; match: string; after: string } {
  const safeOffset = Math.max(0, Math.min(offset, text.length))
  const safeEnd = Math.max(safeOffset, Math.min(safeOffset + length, text.length))
  let before = text.slice(0, safeOffset)
  if (before.length > maxLead) {
    const kept = before.slice(before.length - maxLead)
    const space = kept.indexOf(" ")
    before = `…${space === -1 ? kept : kept.slice(space + 1)}`
  }
  return {
    before,
    match: text.slice(safeOffset, safeEnd),
    after: text.slice(safeEnd),
  }
}
