import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { SURFACES } from "@/components/gallery-fixtures"

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
})
