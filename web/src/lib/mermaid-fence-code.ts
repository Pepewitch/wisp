import { isValidElement, type ReactNode } from "react"

/**
 * The fence's source, if `children` is a mermaid fence. Streamdown renders a
 * fence as `pre > code.language-*`, and highlighting skips mermaid (no
 * highlight.js grammar), so the text is a plain string. Anything else —
 * inline code, another language, the >20 KB fences that lose their language
 * class — is not ours to touch.
 */
export function mermaidFenceCode(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return null
  const { className, children: content } = child.props as {
    className?: unknown
    children?: ReactNode
  }
  const classes = typeof className === "string" ? className.split(/\s+/) : []
  if (!classes.includes("language-mermaid")) return null
  return nodeText(content)
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ""
}
