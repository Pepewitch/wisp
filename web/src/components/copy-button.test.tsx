import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CopyButton } from "./copy-button"

const PROMPT = "https://github.com/acme/app/pull/947\n\n\n[Review instruction]\n\nReview the PR."

afterEach(() => {
  vi.restoreAllMocks()
})

function copyWith(userAgent: string) {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
  render(<CopyButton text={PROMPT} />)
  fireEvent.click(screen.getByRole("button", { name: "Copy" }))
  return writeText
}

describe("CopyButton", () => {
  it("copies a link-led prompt so iOS pastes it as text", async () => {
    const writeText = copyWith("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)")
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`\u2060${PROMPT}`))
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()
  })

  it("copies the prompt verbatim elsewhere", async () => {
    const writeText = copyWith("Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0")
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROMPT))
  })
})
