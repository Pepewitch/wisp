/** The minimum of hast needed to split highlighted code without a type dependency. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

interface LineFragment {
  nodes: HastNode[]
  endsLine: boolean
}

function splitNode(node: HastNode): Array<{ node: HastNode; endsLine: boolean }> {
  if (node.type === "text") {
    const value = node.value ?? ""
    const pieces: Array<{ node: HastNode; endsLine: boolean }> = []
    let start = 0
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 10) continue
      pieces.push({
        node: { ...node, value: value.slice(start, index) },
        endsLine: true,
      })
      start = index + 1
    }
    if (start < value.length) {
      pieces.push({ node: { ...node, value: value.slice(start) }, endsLine: false })
    }
    return pieces
  }

  if (!node.children) return [{ node, endsLine: false }]
  return splitNodes(node.children).map((fragment) => ({
    node: { ...node, children: fragment.nodes },
    endsLine: fragment.endsLine,
  }))
}

function splitNodes(nodes: HastNode[]): LineFragment[] {
  const lines: LineFragment[] = [{ nodes: [], endsLine: false }]
  for (const node of nodes) {
    for (const piece of splitNode(node)) {
      const current = lines.at(-1)!
      current.nodes.push(piece.node)
      if (!piece.endsLine) continue
      current.endsLine = true
      lines.push({ nodes: [], endsLine: false })
    }
  }
  if (lines.length > 1 && lines.at(-1)!.nodes.length === 0) lines.pop()
  return lines
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/**
 * Split a highlighted code tree into addressable source-line spans.
 *
 * This runs after syntax highlighting, so each line keeps the token spans
 * emitted by lowlight. Newlines remain text between the wrappers, preserving
 * copied source while letting the viewer colour one complete visual row.
 */
export function rehypeSourceLines({
  line,
  endLine = line,
}: {
  line: number
  endLine?: number
}) {
  return (tree: HastNode) => {
    walk(tree, (node) => {
      if (node.tagName !== "code" || !node.children) return
      const lines = splitNodes(node.children)
      node.children = lines.flatMap((fragment, index) => {
        const sourceLine = index + 1
        const targeted = sourceLine >= line && sourceLine <= endLine
        const span: HastNode = {
          type: "element",
          tagName: "span",
          properties: {
            className: [
              "source-code-line",
              ...(targeted ? ["source-line-target"] : []),
            ],
            dataSourceLine: sourceLine,
            ...(targeted ? { ariaCurrent: "location" } : {}),
          },
          children: fragment.nodes,
        }
        return fragment.endsLine
          ? [span, { type: "text", value: "\n" }]
          : [span]
      })
    })
  }
}
