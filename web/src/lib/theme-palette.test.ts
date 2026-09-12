import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { SURFACES } from "@/components/gallery-fixtures"

import { DIAGRAM_TOKENS, diagramColour } from "./mermaid-theme"
import { applyTheme } from "./theme"

const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8")
const [darkCss, lightCss] = css.split(":root.light {")

function color(block: string, token: string): string {
  const value = new RegExp(`${token}:\\s*(#[\\da-f]{6});`, "i").exec(block)?.[1]
  if (!value) throw new Error(`Missing color: ${token}`)
  return value.toLowerCase()
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe("theme palette", () => {
  it("keeps gallery labels and browser chrome in step with both palettes", () => {
    for (const [theme, block] of [["dark", darkCss!], ["light", lightCss!]] as const) {
      for (const surface of SURFACES) {
        expect(color(block, surface.token)).toBe(surface[theme].toLowerCase())
      }
      applyTheme(theme)
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content"))
        .toBe(color(block, "--surface"))
    }
    applyTheme("dark")
  })

  it("preserves the dark surface hierarchy above a charcoal reading column", () => {
    const levels = ["--background", "--surface", "--code", "--popover", "--card", "--hover", "--accent"]
      .map((token) => luminance(color(darkCss!, token)))
    expect(levels[0]).toBeGreaterThan(0.006)
    expect(levels[0]).toBeLessThan(0.009)
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]).toBeGreaterThan(levels[index - 1]!)
    }
  })

  it("keeps reading text and code comments readable on the brighter surfaces", () => {
    for (const surface of ["--background", "--surface", "--code", "--card", "--popover", "--hover", "--accent"]) {
      for (const text of ["--foreground", "--fg-secondary", "--muted-foreground"]) {
        expect(contrast(color(darkCss!, text), color(darkCss!, surface))).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const role of ["keyword", "string", "number", "entity", "comment"]) {
      expect(contrast(color(darkCss!, `--syntax-${role}`), color(darkCss!, "--code")))
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it("keeps four distinct text levels without pushing prose to pure white", () => {
    const levels = ["--faint", "--muted-foreground", "--fg-secondary", "--foreground"]
      .map((token) => luminance(color(darkCss!, token)))
    for (let index = 1; index < levels.length; index++) {
      expect(levels[index]! - levels[index - 1]!).toBeGreaterThan(0.08)
    }
    expect(levels[3]).toBeLessThan(0.9)
    expect(contrast(color(darkCss!, "--faint"), color(darkCss!, "--background")))
      .toBeGreaterThanOrEqual(4.5)
  })

  /**
   * Mermaid bakes its palette into the SVG, so a diagram's colours have to
   * exist as strings in TypeScript as well as tokens in CSS. Two copies is
   * one more than the app allows anywhere else, and this is what pays for it.
   */
  describe("diagrams", () => {
    const NAMES = { "--diagram-node": "node", "--diagram-node-border": "nodeBorder", "--diagram-line": "line" } as const

    it("mirrors every diagram token, in both themes", () => {
      for (const [theme, block] of [["dark", darkCss!], ["light", lightCss!]] as const) {
        for (const token of DIAGRAM_TOKENS) {
          expect(diagramColour(theme, NAMES[token])).toBe(color(block, token))
        }
      }
    })

    it("reuses the app's own tokens for everything a diagram does not need its own", () => {
      // a subgraph is `--surface` outlined in `--border-strong`, a note is a
      // `--card`, labels are the text hierarchy — no private greys
      for (const [theme, block] of [["dark", darkCss!], ["light", lightCss!]] as const) {
        expect(diagramColour(theme, "canvas")).toBe(color(block, "--code"))
        expect(diagramColour(theme, "group")).toBe(color(block, "--surface"))
        expect(diagramColour(theme, "groupBorder")).toBe(color(block, "--border-strong"))
        expect(diagramColour(theme, "note")).toBe(color(block, "--card"))
        expect(diagramColour(theme, "text")).toBe(color(block, "--foreground"))
        expect(diagramColour(theme, "secondaryText")).toBe(color(block, "--fg-secondary"))
      }
    })

    it("draws a node with its border and keeps its fill under the prompt bubble", () => {
      for (const block of [darkCss!, lightCss!]) {
        const node = color(block, "--diagram-node")
        // the border is what you see, so it has to clear the fill it sits on
        expect(contrast(color(block, "--diagram-node-border"), node)).toBeGreaterThanOrEqual(2.2)
        // and a label on that fill has to be readable
        expect(contrast(color(block, "--foreground"), node)).toBeGreaterThanOrEqual(4.5)
        // an edge has to be traceable across the canvas
        expect(contrast(color(block, "--diagram-line"), color(block, "--code"))).toBeGreaterThanOrEqual(3)
      }
      // §1: nothing inside a turn may meet or pass the prompt bubble's surface
      expect(luminance(color(darkCss!, "--diagram-node")))
        .toBeLessThan(luminance(color(darkCss!, "--card")))
    })
  })
})
