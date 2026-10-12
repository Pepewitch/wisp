import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CopyButton } from "@/components/copy-button"

import { clipboardSafeText } from "./clipboard"
import { isIOS } from "./platform"

const PROMPT = "https://github.com/acme/app/pull/947\n\n\n[Review instruction]\n\nReview the PR."

afterEach(() => {
  vi.restoreAllMocks()
})

describe("clipboardSafeText", () => {
  it("leads scheme-shaped prose with a word joiner on iOS, keeping every character", () => {
    expect(clipboardSafeText(PROMPT, true)).toBe(`\u2060${PROMPT}`)
    expect(clipboardSafeText("Name: Joe Schmo\nPhone: 555", true)).toBe("\u2060Name: Joe Schmo\nPhone: 555")
  })

  it("leaves a bare URL alone, so it still pastes as a link", () => {
    expect(clipboardSafeText("https://github.com/acme/app/pull/947", true)).toBe("https://github.com/acme/app/pull/947")
    expect(clipboardSafeText("https://example.com/search?q[]=a&b=1#top", true)).toBe(
      "https://example.com/search?q[]=a&b=1#top",
    )
  })

  it("leaves text iOS would not read as a URL alone", () => {
    expect(clipboardSafeText("Review the PR: https://github.com/acme/app/pull/947", true)).toBe(
      "Review the PR: https://github.com/acme/app/pull/947",
    )
    expect(clipboardSafeText("cd /tmp/wt && claude --resume s-1", true)).toBe("cd /tmp/wt && claude --resume s-1")
    expect(clipboardSafeText("", true)).toBe("")
  })

  it("changes nothing off iOS", () => {
    expect(clipboardSafeText(PROMPT, false)).toBe(PROMPT)
  })
})

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

describe("CopyButton", () => {
  function copyWith(userAgent: string) {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    render(<CopyButton text={PROMPT} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    return writeText
  }

  it("copies a link-led prompt so iOS pastes it as text", async () => {
    const writeText = copyWith("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)")
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`\u2060${PROMPT}`))
  })

  it("copies the prompt verbatim elsewhere", async () => {
    const writeText = copyWith("Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0")
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROMPT))
  })
})
