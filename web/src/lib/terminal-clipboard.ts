/**
 * What "copy" means in the terminal pane, as two pure functions.
 *
 * There are THREE kinds of selection in play here and they are not
 * interchangeable, which is the whole reason this is not one line in the
 * component:
 *
 *  1. xterm's own, drawn with a mouse. It is driven by `mousedown`/`mousemove`,
 *     and a touch drag emits no `mousemove`, so it can only ever exist under a
 *     pointer.
 *  2. the PLATFORM's, from a long press. The pane hands `.xterm-rows` back to
 *     the browser on a coarse pointer (see index.css) precisely so a finger has
 *     some way to select at all — and that selection lives in the DOM, where
 *     xterm cannot see it.
 *  3. no selection, which on a phone is the common case.
 *
 * Copy has to answer all three, in that order, or it contradicts itself: a
 * control that offers "the selection" while consulting only the one a finger
 * cannot make would ignore the long press and copy the whole buffer instead.
 *
 * The fallback reads the buffer directly rather than going through
 * `selectAll()` + `getSelection()`. That spelling is shorter but it paints
 * xterm's selection overlay across the pane for a frame and, worse, replaces
 * whatever the platform had selected — destroying case 2 on its way to
 * answering case 3.
 *
 * Both functions take structural types rather than xterm's, so they can be
 * exercised against a stub instead of a real terminal in a real DOM.
 */

/** The part of `IBufferLine` this needs. */
export interface BufferLineLike {
  /** True when this line is the continuation of the one above, not a new one. */
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** The part of `IBuffer` this needs. */
export interface BufferLike {
  readonly length: number
  getLine(y: number): BufferLineLike | undefined
}

/**
 * Everything the shell has printed, scrollback included, as text.
 *
 * Soft-wrapped lines are rejoined. The terminal broke them at the pane's
 * width, which is a fact about the pane and not about the output — a copied
 * command that kept those breaks would paste as several commands the shell
 * cannot run.
 */
export function bufferText(buffer: BufferLike): string {
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    // Trim the row's empty right edge — but NOT when the row below continues
    // it. A continued row is full to the margin, and if its last cell happens
    // to be the space between two words, trimming would join them: `foo bar`
    // copied back as `foobar`.
    const text = line.translateToString(buffer.getLine(y + 1)?.isWrapped !== true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  // The rows below the prompt are blank screen, not output.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

/** The part of `Selection` this needs. */
export interface SelectionLike {
  readonly isCollapsed: boolean
  readonly anchorNode: Node | null
  readonly focusNode: Node | null
  toString(): string
}

/**
 * The platform's selection, but only when the WHOLE of it lies inside `root`.
 *
 * Both ends are checked, not just the anchor: a selection that starts in the
 * terminal and ends in the conversation beside it is not this pane's to copy,
 * and taking it would hand back text the user cannot see in the shell.
 */
export function selectionWithin(root: Node | null, selection: SelectionLike | null): string {
  if (!root || !selection || selection.isCollapsed) return ""
  const { anchorNode, focusNode } = selection
  if (!anchorNode || !focusNode) return ""
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return ""
  return selection.toString()
}
