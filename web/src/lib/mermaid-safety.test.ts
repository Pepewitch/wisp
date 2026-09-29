import { describe, expect, it } from "vitest"

import {
  cssLoadsRemote,
  MERMAID_SAFE_CONFIG,
  neutralizeCss,
  refuseRemoteDiagramImages,
  sanitizeMermaidSvg,
} from "./mermaid-safety"

const EVIL = "https://evil.example"

/** An SVG shaped like mermaid's: a <style>, a node, and one HTML label. */
function diagram(label: string, extra = ""): string {
  return (
    `<svg id="m1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="graphics-document document">` +
    `<style>#m1{font-family:monospace;fill:#333;}#m1 .node rect{fill:#251d32;}</style>` +
    `<g class="nodes"><g class="node default" id="m1-flowchart-A-0">` +
    `<rect class="basic label-container" width="80" height="40"></rect>` +
    `<g class="label"><foreignObject width="80" height="24">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap;">` +
    `<span class="nodeLabel"><p>${label}</p></span></div></foreignObject></g></g>${extra}</g></svg>`
  )
}

/** What a browser could fetch or follow from this markup, by attribute or CSS. */
function remoteReferences(svg: string): string[] {
  return svg.match(/evil\.example[^"'\s)]*/g) ?? []
}

/**
 * Each vector here made a request (or a navigation) in headless Chrome with
 * mermaid 11 at `securityLevel: "strict"`: mermaid's own pass keeps them all.
 */
describe("sanitizeMermaidSvg", () => {
  it.each([
    ["an HTML-label image", diagram(`<img src="${EVIL}/label.png">`)],
    ["an image shape", diagram("x", `<image href="${EVIL}/shape.png" width="60" height="60"></image>`)],
    ["an xlink image", diagram("x", `<image xlink:href="${EVIL}/xlink.png"></image>`)],
    ["a srcset", diagram(`<img srcset="${EVIL}/srcset.png 1x">`)],
    ["a picture source", diagram(`<picture><source srcset="${EVIL}/source.png"></picture>`)],
    ["a video poster", diagram(`<video poster="${EVIL}/poster.png"></video>`)],
    ["a table background", diagram(`<table background="${EVIL}/bg.png"><tbody><tr><td>x</td></tr></tbody></table>`)],
    ["an external use", diagram("x", `<use href="${EVIL}/sprite.svg#icon"></use>`)],
    ["an inline style url()", diagram(`<span style="background-image:url(${EVIL}/inline.png)">s</span>`)],
    ["an escaped inline style url()", diagram(`<span style="background:\\75rl(${EVIL}/escaped.png)">s</span>`)],
    ["a presentation attribute url()", diagram("x", `<rect fill="url(${EVIL}/paint.svg#p)"></rect>`)],
  ])("removes %s", (_, svg) => {
    expect(remoteReferences(svg)).not.toHaveLength(0)
    const clean = sanitizeMermaidSvg(svg)
    expect(remoteReferences(clean)).toEqual([])
    // and the diagram around it is still there
    expect(clean).toContain('class="nodeLabel"')
  })

  it("removes a <style> url(), @import and image-set() but keeps the rest of the sheet", () => {
    const clean = sanitizeMermaidSvg(
      diagram("x").replace(
        "</style>",
        `@import url(${EVIL}/import.css);#m1 .x{background:url('${EVIL}/style.png');color:red;}` +
          `#m1 .y{background-image:image-set("${EVIL}/set.png" 1x);}</style>`,
      ),
    )
    expect(remoteReferences(clean)).toEqual([])
    expect(clean).toContain("#m1 .node rect{fill:#251d32;}")
    expect(clean).toContain("color:red")
  })

  it("drops the anchor a click line produces but keeps the node it wraps", () => {
    const svg = diagram("x").replace(
      '<g class="node default"',
      `<a xlink:href="${EVIL}/click" transform="translate(10, 10)"><g class="node default"`,
    ).replace("</g></g></g></svg>", "</g></g></a></g></svg>")
    const clean = sanitizeMermaidSvg(svg)
    expect(clean).not.toMatch(/<a[\s>]/)
    expect(remoteReferences(clean)).toEqual([])
    expect(clean).toContain('id="m1-flowchart-A-0"')
  })

  it.each([
    ["a form", `<form action="${EVIL}/f"><input name="q"><button>go</button></form>`],
    ["a select", `<select name="s"><option>one</option></select>`],
    ["a textarea", `<textarea name="t">hi</textarea>`],
    ["an HTML anchor", `<a href="${EVIL}/a">link</a>`],
  ])("removes %s from a label", (_, label) => {
    const clean = sanitizeMermaidSvg(diagram(label))
    expect(clean).not.toMatch(/<(form|input|button|select|textarea|a)[\s>]/)
    expect(remoteReferences(clean)).toEqual([])
  })

  /**
   * What mermaid itself emits must come back unchanged: HTML labels in
   * `<foreignObject>`, `<br>` line breaks, `dominant-baseline` text, local
   * `url(#…)` markers, inline style, inline data images. The
   * same pass was run over real flowchart, sequence, class, state, ER, gantt,
   * pie, mindmap and gitGraph output in Chrome and returned each byte for byte.
   */
  it("returns a well-formed diagram exactly as mermaid produced it", () => {
    const svg = diagram(
      "line one<br>line two",
      `<g class="cluster" id="m1-S"><rect style="fill: #19191d;" width="120" height="80"></rect></g>` +
        `<path d="M0 0 L10 10" class="flowchart-link" style="stroke-width: 1px;" marker-end="url(#m1_flowchart-v2-pointEnd)"></path>` +
        `<text x="75" y="32.5" dominant-baseline="central" class="actor"><tspan x="75" dy="0">Alice</tspan></text>` +
        `<image href="data:image/png;base64,iVBORw0KGgo=" width="40" height="40"></image>`,
    )
    expect(sanitizeMermaidSvg(svg)).toBe(svg)
  })
})

describe("neutralizeCss", () => {
  it("leaves CSS that makes no request byte for byte", () => {
    const css = `#m1 .marker{fill:#333;}#m1 .edge{marker-end:url(#m1-arrow);}`
    expect(cssLoadsRemote(css)).toBe(false)
    expect(neutralizeCss(css)).toBe(css)
  })

  it("sees through CSS escapes and comments", () => {
    expect(cssLoadsRemote(`a{background:u\\72 l(${EVIL}/x.png)}`)).toBe(true)
    expect(cssLoadsRemote(`a{background:url/**/(${EVIL}/x.png)}`)).toBe(true)
    expect(neutralizeCss(`a{background:u\\72 l(${EVIL}/x.png)}`)).not.toContain("evil.example")
  })
})

describe("MERMAID_SAFE_CONFIG", () => {
  /** A directive may not re-enable what the label pass exists to remove. */
  it("keeps label HTML settings and CSS injection out of a diagram's reach", () => {
    expect(MERMAID_SAFE_CONFIG.securityLevel).toBe("strict")
    for (const key of ["htmlLabels", "dompurifyConfig", "themeCSS", "fontFamily", "securityLevel", "secure"]) {
      expect(MERMAID_SAFE_CONFIG.secure).toContain(key)
    }
    for (const tag of ["img", "image", "a", "form", "input", "button", "select", "textarea", "style"]) {
      expect(MERMAID_SAFE_CONFIG.dompurifyConfig.FORBID_TAGS).toContain(tag)
    }
  })
})

describe("refuseRemoteDiagramImages", () => {
  const withImage = (img: string) => ({ db: { getVertices: () => new Map([["A", { id: "A", img }]]) } })

  it("refuses an image shape that would be fetched", () => {
    expect(() => refuseRemoteDiagramImages(withImage(`${EVIL}/shape.png`))).toThrow(/network/)
    expect(() => refuseRemoteDiagramImages(withImage("/relative.png"))).toThrow(/network/)
  })

  it("lets an inline image and every other diagram through", () => {
    expect(() => refuseRemoteDiagramImages(withImage("data:image/png;base64,iVBORw0KGgo="))).not.toThrow()
    expect(() => refuseRemoteDiagramImages({ db: { getVertices: () => new Map([["A", { id: "A" }]]) } })).not.toThrow()
    expect(() => refuseRemoteDiagramImages({ db: {} })).not.toThrow()
  })
})
