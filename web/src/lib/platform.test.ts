import { describe, expect, it } from "vitest"

import { isIOS } from "./platform"

describe("isIOS", () => {
  it("knows an iPhone, and an iPad that reports itself as a Mac", () => {
    expect(isIOS({ platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", maxTouchPoints: 5 })).toBe(true)
    expect(isIOS({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5 })).toBe(true)
  })

  it("does not take a Mac or another phone for one", () => {
    expect(isIOS({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 })).toBe(false)
    expect(isIOS({ platform: "Linux armv8l", userAgent: "Mozilla/5.0 (Linux; Android 15)", maxTouchPoints: 5 })).toBe(false)
    expect(isIOS(undefined)).toBe(false)
  })
})
