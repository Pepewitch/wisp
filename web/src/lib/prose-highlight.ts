import { useEffect, useSyncExternalStore } from "react"

import { lazyModule } from "@/lib/lazy-module"

/**
 * Syntax highlighting for a fence that NAMED a language, and nothing else.
 *
 * `rehype-highlight` (lowlight → highlight.js) runs at the end of Streamdown's
 * rehype chain, after `sanitize`, so the `hljs-*` spans it adds survive. It
 * emits CLASSES rather than inline colours, which is what lets the palette be
 * Wisp's own tokens (`--syntax-*` in `index.css`) instead of somebody else's
 * theme, and what keeps it clear of the packaged app's CSP.
 *
 * Two options carry the whole policy:
 *
 *  - `detect: false` (the default, named here because it is load-bearing) — an
 *    unlabelled fence is never guessed at. A bare ``` is plain, which is the
 *    rule the block surface already states.
 *  - `ignoreMissing: true` — a fence naming something outside the common set
 *    (`mermaid`, `solidity`, a typo) renders plain instead of throwing. An
 *    agent's prose is not a build input; it must not be able to break a turn.
 */
const HIGHLIGHT_LIMIT = 20_000
const STATIC_HIGHLIGHT_LIMIT = 50_000

/** The minimum of hast this module needs, so it needs no type dependency. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function textLength(node: HastNode): number {
  if (node.type === "text") return node.value?.length ?? 0
  return (node.children ?? []).reduce((total, child) => total + textLength(child), 0)
}

function classList(node: HastNode): string[] {
  const raw = node.properties?.className
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "string") return raw.split(/\s+/)
  return []
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/**
 * Highlighting is O(size) and it reruns on every chunk while a fence is still
 * arriving, so one pasted 100 KB file would spend ~73ms per frame re-colouring
 * the same block (measured). Past the limit the language class comes OFF, and
 * a block with no language is exactly what it then renders as: plain mono, the
 * same treatment a bare fence gets. Nothing is hidden and nothing stalls.
 */
function skipCodePast(limit: number) {
  return function rehypeSkipHugeCode() {
    return (tree: HastNode) => {
      walk(tree, (node) => {
        if (node.tagName !== "code" || !node.properties) return
        const classes = classList(node)
        if (!classes.some((name) => name.startsWith("language-"))) return
        if (textLength(node) <= limit) return
        node.properties.className = classes.filter((name) => !name.startsWith("language-"))
      })
    }
  }
}

/**
 * highlight.js and its common grammars are the second-largest thing in the
 * browser bundle, and only a fence that names a language uses them, so the
 * browser loads them on first use (`lazy-module.ts`). Until they arrive such a
 * fence renders as plain mono on `--code`: the same box, the colour missing,
 * which is also how a fence past the limit renders.
 */
const highlighter = lazyModule(() => import("rehype-highlight").then((module) => module.default))

export type ProseHighlighter = Awaited<ReturnType<typeof highlighter.load>>

/**
 * Ask for the highlighter before a fence needs it: a selected task is about
 * to show prose. Settles either way; a failure leaves fences plain.
 */
export function preloadProseHighlighter(): Promise<void> {
  return highlighter.load().then(
    () => undefined,
    () => undefined
  )
}

/**
 * The highlighter once it has arrived, else null, asking for it on first use.
 * A failed load leaves fences plain; the next mount asks again.
 */
export function useProseHighlighter(): ProseHighlighter | null {
  const loaded = useSyncExternalStore(highlighter.subscribe, highlighter.current)
  useEffect(() => {
    if (!loaded) void preloadProseHighlighter()
  }, [loaded])
  return loaded
}

/**
 * The highlighting end of the rehype chain for one limit. Without the
 * highlighter it still strips a huge block's language, so that block looks
 * the same before and after the highlighter arrives.
 */
export function highlightPlugins(limit: number, highlight: ProseHighlighter | null) {
  const skip = skipCodePast(limit)
  return highlight
    ? ([skip, [highlight, { detect: false, ignoreMissing: true }]] as const)
    : ([skip] as const)
}

export const PROSE_HIGHLIGHT_LIMIT = HIGHLIGHT_LIMIT

/**
 * A complete document or source file is coloured once, not again for every
 * arriving chunk, so it can safely support the ordinary 20–50 KB file range.
 */
export const STATIC_PROSE_HIGHLIGHT_LIMIT = STATIC_HIGHLIGHT_LIMIT
