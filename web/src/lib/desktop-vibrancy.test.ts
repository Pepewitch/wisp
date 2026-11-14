import { describe, expect, it } from "vitest"

import { windowTheme } from "@/lib/desktop-vibrancy"

describe("windowTheme", () => {
  it("pins the window to an explicit theme, so the material matches the tint", () => {
    expect(windowTheme("dark", "dark")).toBe("dark")
    expect(windowTheme("light", "light")).toBe("light")
  })

  it("hands a system preference back to the Mac", () => {
    expect(windowTheme("system", "light")).toBeNull()
    expect(windowTheme("system", "dark")).toBeNull()
  })
})
