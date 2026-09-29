import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The highlighter arrives when the test says so, the way its chunk does.
const chunk = vi.hoisted(() => {
  let arrive!: () => void
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  return { arrived, arrive }
})
vi.mock("rehype-highlight", async (importOriginal) => {
  await chunk.arrived
  return importOriginal()
})

import { Prose } from "./prose"

describe("a fence drawn before the highlighter has arrived", () => {
  it("is the same box in plain mono, and takes its colour once the highlighter lands", async () => {
    const text = "Here:\n\n```ts\nexport const answer = 12\n```"
    const { container } = render(<Prose text={text} />)
    const plain = container.querySelector("pre > code")
    expect(plain).toHaveClass("language-ts")
    expect(plain?.textContent).toContain("export const answer = 12")
    expect(container.querySelectorAll("[class*=hljs-]")).toHaveLength(0)

    chunk.arrive()

    // the text never changes, so this is the block re-rendering on its own
    await waitFor(() => expect(container.querySelector(".hljs-keyword")?.textContent).toBe("export"))
    expect(container.querySelector("pre > code")).toHaveClass("language-ts")
    expect(container.querySelector("pre > code")?.textContent).toContain("export const answer = 12")
  })
})
