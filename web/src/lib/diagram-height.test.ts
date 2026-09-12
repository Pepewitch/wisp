import { beforeEach, describe, expect, it } from "vitest"

import {
  clampDiagramHeight,
  DEFAULT_DIAGRAM_HEIGHT,
  MAX_DIAGRAM_HEIGHT,
  MIN_DIAGRAM_HEIGHT,
  readDiagramHeight,
  writeDiagramHeight,
} from "./diagram-height"

const KEY = "wisp_mermaid_height"

beforeEach(() => localStorage.clear())

describe("diagram height", () => {
  it("opens at the default until someone resizes one", () => {
    expect(readDiagramHeight()).toBe(DEFAULT_DIAGRAM_HEIGHT)
    writeDiagramHeight(520)
    expect(readDiagramHeight()).toBe(520)
  })

  it("keeps a height inside the viewer's bounds", () => {
    expect(clampDiagramHeight(40)).toBe(MIN_DIAGRAM_HEIGHT)
    expect(clampDiagramHeight(9000)).toBe(MAX_DIAGRAM_HEIGHT)
    expect(clampDiagramHeight(412.6)).toBe(413)
  })

  it("falls back to the default for anything storage cannot be trusted with", () => {
    for (const raw of ["", "tall", "NaN", "{}"]) {
      localStorage.setItem(KEY, raw)
      expect(readDiagramHeight()).toBe(DEFAULT_DIAGRAM_HEIGHT)
    }
    // a hand-edited number outside the bounds is clamped, not discarded
    localStorage.setItem(KEY, "99999")
    expect(readDiagramHeight()).toBe(MAX_DIAGRAM_HEIGHT)
  })

  it("survives storage that refuses to answer", () => {
    const denied = {
      getItem() {
        throw new Error("SecurityError")
      },
      setItem() {
        throw new Error("QuotaExceededError")
      },
    }
    expect(readDiagramHeight(denied)).toBe(DEFAULT_DIAGRAM_HEIGHT)
    expect(() => writeDiagramHeight(400, denied)).not.toThrow()
  })
})
