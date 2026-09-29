import createDOMPurify, { type DOMPurify } from "dompurify"
import type { MermaidConfig } from "mermaid"

/**
 * What an agent's ```mermaid fence may NOT do: reach the network, or leave the
 * app, just by being rendered.
 *
 * Remote Markdown images wait for a click (`remote-image.tsx`), and a diagram
 * must not be the way around that. Mermaid's `strict` level stops scripts, but
 * its own DOMPurify pass keeps `<img src=https://…>`, `<image href=https://…>`,
 * forms, `url(https://…)` in styles, and the `<a xlink:href>` a `click` line
 * produces. Any of those is a request a hostile agent can use as a beacon, or
 * a link that navigates the Wisp window itself.
 *
 * Mermaid also measures labels by putting them in the live document WHILE it
 * renders, so a pass over the finished SVG alone is too late for a label: its
 * image has already been fetched. Three layers, each covering what the one
 * after it cannot:
 *
 * 1. `MERMAID_SAFE_CONFIG` — label HTML is purified before mermaid measures it,
 *    and a diagram's own `%%{init}%%` or front-matter cannot turn that off,
 *    re-enable HTML labels, or inject CSS.
 * 2. `refuseRemoteDiagramImages` — an image shape (`A@{ img: … }`) is loaded
 *    by mermaid during layout, before anything returns, so a diagram that
 *    names a remote one is not rendered at all and stays source.
 * 3. `sanitizeMermaidSvg` — what reaches `dangerouslySetInnerHTML` has no
 *    remote reference and nothing to click or submit.
 */

/** Elements that fetch something or do something when activated. */
const ACTIVE_TAGS = [
  "a",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "iframe",
  "frame",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "script",
]

/** Attributes whose value is a URL something may load or navigate to. */
const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "data",
  "cite",
  "longdesc",
  "lowsrc",
  "dynsrc",
  "ping",
  "codebase",
  "archive",
  "usemap",
  "manifest",
  "icon",
  "profile",
])

/**
 * Mermaid's secure keys, plus the ones that decide what a label may contain.
 * A key listed here cannot be changed by a diagram's directive or front
 * matter, and mermaid applies the list at every depth, so `htmlLabels` also
 * covers `flowchart.htmlLabels`. `htmlLabels` itself keeps mermaid's default:
 * turning it off would change how every diagram looks.
 */
export const MERMAID_SECURE_KEYS = [
  // mermaid's own defaults, restated because `secure` is replaced, not merged
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "dompurifyConfig",
  // a directive's CSS goes into the SVG's <style> as written, url() and all
  "themeCSS",
  "fontFamily",
  "altFontFamily",
]

/**
 * The config every render starts from. `dompurifyConfig` REPLACES mermaid's
 * default label pass (which forbids only `<style>`), so it says `style` again.
 * Inline `style` goes too: a label's own `url()` would be fetched during
 * measurement, before the SVG pass could see it, and mermaid applies its
 * `style`/`classDef` colours outside this pass.
 */
export const MERMAID_SAFE_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  secure: MERMAID_SECURE_KEYS,
  dompurifyConfig: {
    FORBID_TAGS: [...ACTIVE_TAGS, "style", "image", "use", "feimage"],
    FORBID_ATTR: ["style", ...URL_ATTRIBUTES],
  },
} satisfies MermaidConfig

/** `data:image/…`, which an `<image>` can show without a request. */
const isInlineImage = (value: string) => /^data:image\//i.test(value.trim())

/**
 * Refuse, before rendering, a diagram whose image shapes name a remote URL.
 * `diagram` is what `mermaidAPI.getDiagramFromText` returns; only flowcharts
 * have image shapes, and a diagram without vertices passes untouched.
 */
export function refuseRemoteDiagramImages(diagram: unknown): void {
  const db = (diagram as { db?: { getVertices?: () => unknown } } | null)?.db
  const vertices = typeof db?.getVertices === "function" ? db.getVertices() : null
  if (!vertices || typeof vertices !== "object") return
  const list = vertices instanceof Map ? [...vertices.values()] : Object.values(vertices)
  for (const vertex of list) {
    const img = (vertex as { img?: unknown } | null)?.img
    if (typeof img === "string" && img.trim() !== "" && !isInlineImage(img)) {
      throw new Error("This diagram loads an image from the network, so it is shown as source.")
    }
  }
}

/** CSS with its escapes decoded and comments dropped: what a browser reads. */
function plainCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-f])/gi, (_, hex: string | undefined, char: string | undefined) => {
      if (char !== undefined) return char
      const code = Number.parseInt(hex ?? "", 16)
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�"
    })
}

/** `url(…)` whose target is anything but a fragment of this document. */
const REMOTE_URL = /url\(\s*(?!["']?\s*#)/i
const URL_CALL = /url\(\s*("[^"]*"|'[^']*'|[^)"']*)\s*\)/gi

/** Whether CSS text can make a request: a non-fragment url(), @import, image-set(). */
export function cssLoadsRemote(css: string): boolean {
  const plain = plainCss(css)
  return REMOTE_URL.test(plain) || /@import|image-set\(/i.test(plain)
}

/**
 * CSS with every request removed. Mermaid's own stylesheet makes none and is
 * returned exactly as it came; anything else is rewritten from its decoded
 * form, and emptied if the rewrite still leaves something that could load.
 */
export function neutralizeCss(css: string): string {
  if (!cssLoadsRemote(css)) return css
  const rewritten = plainCss(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\([^;{}]*/gi, "none")
    .replace(URL_CALL, (call: string, target: string) => (/^["']?\s*#/.test(target) ? call : "none"))
  return cssLoadsRemote(rewritten) ? "" : rewritten
}

let purifier: DOMPurify | null = null

/** A private instance, so these hooks never touch mermaid's own DOMPurify. */
function svgPurifier(): DOMPurify {
  if (purifier) return purifier
  const instance = createDOMPurify(window)
  instance.addHook("uponSanitizeElement", (node) => {
    if (node.nodeName.toLowerCase() === "style" && node.textContent) {
      node.textContent = neutralizeCss(node.textContent)
    }
  })
  instance.addHook("uponSanitizeAttribute", (node, data) => {
    const value = data.attrValue
    if (URL_ATTRIBUTES.has(data.attrName)) {
      const local = value.trim().startsWith("#")
      const inline = node.nodeName.toLowerCase() === "image" && data.attrName !== "srcset" && isInlineImage(value)
      if (!local && !inline) data.keepAttr = false
      return
    }
    if (cssLoadsRemote(value)) data.keepAttr = false
  })
  purifier = instance
  return instance
}

/**
 * The SVG mermaid returned, with nothing left that loads, navigates or
 * submits. Mermaid's own pass options are repeated so a well-formed diagram
 * comes back as it went in: HTML labels live in `<foreignObject>`, and text
 * alignment in `dominant-baseline`. An `<a>` is dropped but its content kept,
 * so a `click` node is still drawn, just inert.
 */
export function sanitizeMermaidSvg(svg: string): string {
  return svgPurifier().sanitize(svg, {
    ADD_TAGS: ["foreignobject"],
    ADD_ATTR: ["dominant-baseline"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ACTIVE_TAGS,
  })
}
