import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Prose } from "./prose"

/**
 * The three things agents emit that a hand-rolled inline parser could not do:
 * tables, lists, and links you can actually click.
 */
describe("Prose", () => {
  it("renders bold and italic instead of printing their delimiters", () => {
    const { container } = render(<Prose text="**Verdict: request changes** — one *blocking* bug." />)
    expect(container.querySelector("strong")?.textContent).toBe("Verdict: request changes")
    expect(container.querySelector("em")?.textContent).toBe("blocking")
    expect(container.textContent).not.toContain("**")
  })

  it("renders a GFM table", () => {
    const { container } = render(
      <Prose text={"| harness | effort |\n| --- | --- |\n| droid | xhigh |\n| codex | max |"} />,
    )
    expect(container.querySelectorAll("th")).toHaveLength(2)
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(screen.getByText("droid")).toBeInTheDocument()
  })

  it("renders bulleted and numbered lists", () => {
    const { container } = render(<Prose text={"- first\n- second\n"} />)
    expect(container.querySelectorAll("ul li")).toHaveLength(2)
    const ordered = render(<Prose text={"1. one\n2. two\n"} />)
    expect(ordered.container.querySelectorAll("ol li")).toHaveLength(2)
  })

  it("makes a link clickable, opening in a new tab, and never trusts the href", () => {
    const { container } = render(<Prose text="see [the PR](https://github.com/example-org/sample-app/pull/42)" />)
    const link = container.querySelector("a")
    expect(link?.getAttribute("href")).toBe("https://github.com/example-org/sample-app/pull/42")
    expect(link?.getAttribute("target")).toBe("_blank")
    // the href comes from model output — no window.opener, no referrer
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("autolinks a bare URL, which is how agents usually paste one", () => {
    const { container } = render(<Prose text="Posted: https://github.com/example-org/sample-app/pull/42" />)
    expect(container.querySelector("a")?.getAttribute("href")).toContain("/pull/42")
  })

  it("keeps a code span literal — the regex that broke the old parser", () => {
    const { container } = render(<Prose text={'`/"Custom"\\s*:\\s*"?1"?/` never matches'} />)
    const code = container.querySelector("code")
    expect(code?.textContent).toBe('/"Custom"\\s*:\\s*"?1"?/')
    expect(container.querySelector("em")).toBeNull() // the asterisks are not italics
  })

  it("leaves bare identifiers alone — underscores are not emphasis here", () => {
    const { container } = render(<Prose text="SOLANA_RENT_SHORTFALL and account_index" />)
    expect(container.querySelector("em")).toBeNull()
    expect(container.textContent).toContain("SOLANA_RENT_SHORTFALL")
  })

  /**
   * The stream tells the person's words from the agent's by lightness alone,
   * so the prompt bubble (`bg-card`) has to be the lightest surface in a turn.
   * A code block sharing that fill made the two one shape at a glance.
   */
  it("keeps a code block off the prompt bubble's surface", () => {
    const { container } = render(<Prose text={"```ts\nconst x = 1\n```"} />)
    const pre = container.querySelector("pre")
    expect(pre?.className).toContain("bg-code")
    expect(pre?.className).not.toContain("bg-card")
  })

  /**
   * Each line of an agent transcript is a separate message the harness emitted.
   * CommonMark folds a single newline into a space, which ran a turn's status
   * lines together into one paragraph — the reported "string join" bug.
   */
  describe("line breaks", () => {
    it("keeps consecutive messages on their own lines instead of joining them", () => {
      const { container } = render(
        <Prose text={"Setting up dependencies while I read the code.\nNow let me look at the other affected files."} />,
      )
      expect(container.querySelectorAll("br")).toHaveLength(1)
      // the join that produced ". Now" is gone
      expect(container.textContent).not.toContain("code. Now let me")
    })

    it("still separates real paragraphs, rather than turning them into breaks", () => {
      const { container } = render(<Prose text={"First thought.\n\nSecond thought."} />)
      expect(container.querySelectorAll("p")).toHaveLength(2)
      expect(container.querySelectorAll("br")).toHaveLength(0)
    })

    it("leaves markdown structure alone — a list is still a list, not four broken lines", () => {
      const { container } = render(<Prose text={"Here is the plan:\n\n- read it\n- fix it\n- test it"} />)
      expect(container.querySelectorAll("ul li")).toHaveLength(3)
      expect(container.querySelectorAll("li br")).toHaveLength(0)
    })

    it("does not break inside a fenced code block", () => {
      const { container } = render(<Prose text={"```\nline one\nline two\n```"} />)
      expect(container.querySelector("pre")).not.toBeNull()
      expect(container.querySelectorAll("pre br")).toHaveLength(0)
    })

    it("keeps tables working — the default plugins were not replaced", () => {
      const { container } = render(<Prose text={"| a | b |\n| --- | --- |\n| 1 | 2 |"} />)
      expect(container.querySelectorAll("th")).toHaveLength(2)
    })
  })
})
