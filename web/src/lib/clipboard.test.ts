import { afterEach, describe, expect, it, vi } from "vitest"

import { clipboardSafeText, readClipboardText } from "./clipboard"

const PROMPT = "https://github.com/acme/app/pull/947\n\n\n[Review instruction]\n\nReview the PR."
const JOINER = "\u2060"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("clipboardSafeText", () => {
  it("leads scheme-shaped prose with a word joiner on iOS, keeping every character", () => {
    expect(clipboardSafeText(PROMPT, true)).toBe(JOINER + PROMPT)
    expect(clipboardSafeText("Name: Joe Schmo\nPhone: 555", true)).toBe(`${JOINER}Name: Joe Schmo\nPhone: 555`)
    expect(clipboardSafeText("https://x.com/a\r\n", true)).toBe(`${JOINER}https://x.com/a\r\n`)
  })

  it("catches text iOS would encode even without a space", () => {
    expect(clipboardSafeText("Note:ภาษาไทย", true)).toBe(`${JOINER}Note:ภาษาไทย`)
    expect(clipboardSafeText("Progress:100%", true)).toBe(`${JOINER}Progress:100%`)
  })

  it("leaves a bare URL alone, so it still pastes as a link", () => {
    for (const url of [
      "https://github.com/acme/app/pull/947",
      "https://example.com/search?q[]=a&b=1#top",
      "https://example.com/a%20b",
      "mailto:a@b.c",
    ]) {
      expect(clipboardSafeText(url, true)).toBe(url)
    }
  })

  it("leaves text iOS would not read as a URL alone", () => {
    for (const text of [
      "Review the PR: https://github.com/acme/app/pull/947",
      "cd /tmp/wt && claude --resume s-1",
      " https://x.com hi",
      "",
    ]) {
      expect(clipboardSafeText(text, true)).toBe(text)
    }
  })

  it("changes nothing off iOS", () => {
    expect(clipboardSafeText(PROMPT, false)).toBe(PROMPT)
  })
})

describe("readClipboardText", () => {
  function clipboardHolding(text: string) {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn().mockResolvedValue(text) },
      configurable: true,
    })
  }

  it("drops the one joiner a Wisp copy added", async () => {
    clipboardHolding(`${JOINER}error: failed to push`)
    await expect(readClipboardText()).resolves.toBe("error: failed to push")
  })

  it("returns anything else untouched", async () => {
    clipboardHolding("echo hi")
    await expect(readClipboardText()).resolves.toBe("echo hi")
  })
})
