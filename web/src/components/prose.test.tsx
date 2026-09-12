import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { WorktreeFileContext } from "@/lib/worktree-files"

import { PROSE_HIGHLIGHT_LIMIT } from "@/lib/prose-highlight"
import { mermaidThemeVariables } from "@/lib/mermaid-theme"
import { DEFAULT_THEME_PREFERENCE, themeStore } from "@/lib/theme"

import { Prose } from "./prose"

const renderDiagram = vi.hoisted(() => vi.fn())
// `getMermaid` carries the theme, so it is a spy of its own
const getMermaid = vi.hoisted(() => vi.fn())
vi.mock("@streamdown/mermaid", () => ({
  // the shape MermaidFence reaches through its dynamic import
  mermaid: {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid,
  },
}))

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

  /**
   * Markdown hands inline code and a fence's contents to the same element, and
   * only a fence that NAMED a language carries a class to tell them apart. A
   * bare fence used to take the inline branch and wear the violet chip around
   * a whole block, on top of the block's own surface.
   */
  it("keeps the chip for a phrase and the plain surface for a block", () => {
    const { container } = render(
      <Prose text={"a `--z-menu` token\n\n```\nwisp task list\n```\n\n```ts\nconst n = 1\n```"} />,
    )

    const [inline, bare, tagged] = [...container.querySelectorAll("code")]
    // the chip is a phrase inside a sentence: accent wash, accent text
    expect(inline?.closest("pre")).toBeNull()
    expect(inline?.className).toContain("bg-accent-wash")

    // a block is a surface, and the block decides — whatever the child chose
    // for itself is reset by the `pre` around it
    for (const block of [bare, tagged]) {
      const pre = block?.closest("pre")
      expect(pre).not.toBeNull()
      expect(pre?.className).toContain("bg-code")
      expect(pre?.className).toContain("[&>code]:bg-transparent")
      expect(pre?.className).toContain("[&>code]:text-inherit")
    }

    // naming a language is what a highlighter reads, so the class survives
    expect(tagged?.className).toContain("language-ts")
    expect(bare?.className ?? "").not.toContain("language-")
  })

  /**
   * Colour goes INSIDE a block that named a language, and nowhere else. The
   * palette is ours (`--syntax-*`), so what the highlighter owes us is the
   * ROLE of each token as a class; jsdom parses no CSS, so the classes are
   * what a test can hold on to.
   */
  it("colours a fence that named a language, by role", () => {
    const { container } = render(
      <Prose text={"```ts\n// why\nexport const limit = 12\n```"} />,
    )

    expect(container.querySelector("code")?.className).toContain("language-ts")
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("export")
    expect(container.querySelector(".hljs-number")?.textContent).toBe("12")
    expect(container.querySelector(".hljs-comment")?.textContent).toContain("why")
  })

  it("leaves a fence that named nothing alone, rather than guessing", () => {
    const { container } = render(<Prose text={"```\nexport const limit = 12\n```"} />)

    // `detect: false` is load-bearing: a bare fence is plain, which is what
    // the block surface already says it is
    expect(container.querySelectorAll("[class*=hljs-]")).toHaveLength(0)
    expect(container.querySelector("pre")?.textContent).toContain("export const limit = 12")
  })

  it("renders a language it does not know as plain text instead of throwing", () => {
    const { container } = render(<Prose text={"```wisp-lang\ngraph TD; a-->b\n```"} />)

    // an agent's prose is not a build input; an unknown fence must not be able
    // to take a turn down with it (`ignoreMissing`)
    expect(container.querySelector("pre")?.textContent).toContain("graph TD")
    expect(container.querySelectorAll("[class*=hljs-]")).toHaveLength(0)
  })

  it("stops highlighting a block too big to colour on every keystroke", () => {
    const line = 'export const value = "highlight me"\n'
    const huge = line.repeat(Math.ceil((PROSE_HIGHLIGHT_LIMIT + 1_000) / line.length))
    const { container } = render(<Prose text={"```ts\n" + huge + "```"} />)

    // past the limit the language class comes off, so it renders as what it
    // then is — a block with no language, which is plain mono
    expect(container.querySelectorAll("[class*=hljs-]")).toHaveLength(0)
    expect(container.querySelector("pre")?.textContent).toContain("highlight me")
  })

  it("survives a fence that is still arriving", () => {
    // the stream renders every chunk, so a fence with no closing ``` yet is a
    // state the highlighter sees constantly
    const { container } = render(<Prose text={"```ts\nexport const half = tru"} />)
    expect(container.querySelector("pre")?.textContent).toContain("export const half")
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

  /**
   * A repository path is the other thing agents link. It is never an anchor:
   * navigating to it would resolve against the app's own origin and take the
   * shell somewhere it cannot come back from. With a task behind the prose it
   * is a button that opens the viewer; without one it is text.
   */
  it("asks for a repository path to be opened rather than navigating to it", () => {
    const open = vi.fn()
    const { container } = render(
      <WorktreeFileContext.Provider value={open}>
        <Prose text="see [terminal.ts](web/src/lib/terminal.ts)" />
      </WorktreeFileContext.Provider>
    )
    expect(container.querySelector("a")).toBeNull()
    const button = screen.getByRole("button", { name: "terminal.ts" })
    expect(button).toHaveAttribute("title", "web/src/lib/terminal.ts")
    fireEvent.click(button)
    expect(open).toHaveBeenCalledExactlyOnceWith("web/src/lib/terminal.ts")
  })

  it("leaves a path as plain text where no worktree is behind the prose", () => {
    const { container } = render(<Prose text="see [terminal.ts](web/src/lib/terminal.ts)" />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.querySelector("button")).toBeNull()
    expect(container.textContent).toContain("terminal.ts")
  })

  /** `sanitize` empties these before Prose sees them; neither may become a file request. */
  it("never asks to open a foreign scheme or an in-document anchor", () => {
    const open = vi.fn()
    const { container } = render(
      <WorktreeFileContext.Provider value={open}>
        <Prose text={"[a](file:///etc/passwd) [b](javascript:alert(1)) [c](#section)"} />
      </WorktreeFileContext.Provider>
    )
    expect(container.querySelector("button")).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })

  /**
   * The rehype chain no longer carries `harden`, which used to replace a
   * relative image with a grey placeholder. A relative `src` resolves against
   * the app's own origin, where nothing answers it, so only an absolute
   * address is rendered as an image at all.
   */
  it("renders only an image that can load, and its alt text otherwise", () => {
    const { container } = render(
      <Prose
        text={"![shot](https://example.test/a.png)\n\n![local shot](docs/shot.png)"}
      />
    )
    const images = container.querySelectorAll("img")
    expect(images).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Load image" }))
    expect(container.querySelector("img")).toHaveAttribute("src", "https://example.test/a.png")
    expect(container.textContent).toContain("local shot")
  })

  /**
   * SEC-03. This URL came from agent prose, so loading it is already an
   * outbound request the reader did not ask for; it must at least not disclose
   * which Wisp page was open when it happened.
   */
  it("sends no referrer with an agent-supplied remote image", () => {
    const { container } = render(<Prose text="![shot](https://example.test/a.png)" />)
    fireEvent.click(screen.getByRole("button", { name: "Load image" }))
    expect(container.querySelector("img")).toHaveAttribute("referrerpolicy", "no-referrer")
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
   * A mermaid fence is source first: the switch renders the diagram only when
   * asked, and the source is one click away again. The renderer behind the
   * dynamic import is mocked here — its zoom/pan surface is the thing under
   * test, not mermaid's parser.
   */
  describe("mermaid fences", () => {
    const FENCE = "```mermaid\ngraph TD\n    a --> b\n```"

    beforeEach(() => {
      renderDiagram.mockReset()
      getMermaid.mockReset()
      getMermaid.mockImplementation(() => ({ initialize: vi.fn(), render: renderDiagram }))
      localStorage.clear()
      // the theme store is module-global; no fence may leave it moved
      themeStore.set(DEFAULT_THEME_PREFERENCE)
    })

    /** The diagram on screen, plus the node its transform is written to. */
    async function openDiagram() {
      renderDiagram.mockResolvedValue({ svg: '<svg data-test="dag" />' })
      const view = render(<Prose text={FENCE} />)
      const surface = await screen.findByRole("application", { name: "Mermaid diagram" })
      return { view, surface, content: surface.firstElementChild as HTMLElement }
    }

    it("shows the diagram as soon as the fence renders as one", async () => {
      renderDiagram.mockResolvedValue({ svg: '<svg data-test="dag" />' })
      const { container } = render(<Prose text={FENCE} />)

      // nobody clicked anything: a fence that means a diagram shows a diagram
      expect(await screen.findByRole("application", { name: "Mermaid diagram" })).toBeInTheDocument()
      expect(container.querySelector("[data-test='dag']")).not.toBeNull()
      expect(renderDiagram).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^wisp-mermaid-/),
        expect.stringContaining("a --> b"),
      )

      // and the switch is still how you get back to the text that made it
      fireEvent.click(screen.getByRole("button", { name: "Show source" }))
      expect(container.querySelector("pre")?.textContent).toContain("a --> b")
      fireEvent.click(screen.getByRole("button", { name: "Render diagram" }))
      expect(await screen.findByRole("application", { name: "Mermaid diagram" })).toBeInTheDocument()
    })

    it("gives a fence that is not mermaid no switch at all", () => {
      const plain = render(<Prose text={"```ts\nconst x = 1\n```"} />)
      expect(plain.container.querySelector("[aria-label='Render diagram']")).toBeNull()
      expect(renderDiagram).not.toHaveBeenCalled()
    })

    /**
     * An agent writes a diagram a character at a time. Until the whole thing
     * parses there is nothing to show, and a parse error mid-turn announces
     * only that the second half has not arrived — so the source stands.
     */
    it("leaves a fence that does not parse as its source, not as an error", async () => {
      renderDiagram.mockRejectedValue(new Error("Parse error on line 2"))
      const { container } = render(<Prose text={FENCE} />)

      await waitFor(() => expect(renderDiagram).toHaveBeenCalled())
      expect(screen.queryByRole("application", { name: "Mermaid diagram" })).toBeNull()
      expect(container.querySelector("pre")?.textContent).toContain("a --> b")
      // the error is still reachable — it is why the diagram is not there
      expect(screen.getByRole("button", { name: "Render diagram" })).toBeInTheDocument()
    })

    it("offers a retry when the diagram cannot be parsed", async () => {
      renderDiagram.mockRejectedValueOnce(new Error("Parse error on line 2"))
      renderDiagram.mockResolvedValue({ svg: '<svg data-test="dag" />' })
      render(<Prose text={FENCE} />)

      fireEvent.click(await screen.findByRole("button", { name: "Render diagram" }))
      expect(await screen.findByText("Parse error on line 2")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      expect(await screen.findByRole("application", { name: "Mermaid diagram" })).toBeInTheDocument()
    })

    /**
     * Mermaid bakes the palette into the SVG, so a theme change is a re-render
     * or it is nothing. The picture has to survive the swap: unmounting the
     * viewer would throw away a pan and zoom someone just set up.
     */
    it("re-renders in the new theme without dropping the view", async () => {
      renderDiagram.mockResolvedValue({ svg: '<svg data-test="dark" />' })
      const { container } = render(<Prose text={FENCE} />)
      const surface = await screen.findByRole("application", { name: "Mermaid diagram" })

      // pan somewhere, so losing the viewer would be visible
      fireEvent.pointerDown(surface, { button: 0, pointerId: 9, clientX: 0, clientY: 0 })
      fireEvent.pointerMove(surface, { pointerId: 9, clientX: 40, clientY: 0 })
      fireEvent.pointerUp(surface, { pointerId: 9, clientX: 40, clientY: 0 })
      const content = surface.firstElementChild as HTMLElement
      await waitFor(() => expect(content.style.transform).toBe("translate3d(40px, 0px, 0) scale(1)"))

      expect(renderDiagram).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything())
      renderDiagram.mockResolvedValue({ svg: '<svg data-test="light" />' })
      act(() => themeStore.set("light"))

      await waitFor(() => expect(container.querySelector("[data-test='light']")).not.toBeNull())
      expect(renderDiagram).toHaveBeenCalledTimes(2)
      // the same viewer, still where it was panned to
      expect(screen.getByRole("application", { name: "Mermaid diagram" })).toBe(surface)
      expect(content.style.transform).toBe("translate3d(40px, 0px, 0) scale(1)")
    })

    /**
     * Mermaid's stock themes are not ours. `base` plus our variables is how a
     * diagram ends up in Wisp's palette rather than mermaid's, and the theme
     * on screen is what picks which end of the scale it gets.
     */
    it("hands mermaid Wisp's palette for the theme that is actually on screen", async () => {
      renderDiagram.mockResolvedValue({ svg: "<svg />" })
      act(() => themeStore.set("light"))
      render(<Prose text={FENCE} />)
      await waitFor(() => expect(renderDiagram).toHaveBeenCalled())
      expect(getMermaid).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "base", themeVariables: mermaidThemeVariables("light") }),
      )

      act(() => themeStore.set("dark"))
      await waitFor(() =>
        expect(getMermaid).toHaveBeenLastCalledWith(
          expect.objectContaining({ theme: "base", themeVariables: mermaidThemeVariables("dark") }),
        ),
      )
      // and the two ends really are different palettes, not one set twice
      expect(mermaidThemeVariables("dark").primaryColor).not.toBe(mermaidThemeVariables("light").primaryColor)
    })

    /**
     * The reported shake. A drag used to set React state per pointer event
     * AND re-aim a 150ms eased CSS transition that had not finished the last
     * one, so the diagram lurched forward and snapped back tens of pixels a
     * second. Input-driven motion is written to the node with no transition;
     * only the discrete button nudges ease.
     */
    it("pans straight to the pointer, with nothing animating the drag", async () => {
      const { surface, content } = await openDiagram()

      fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 140, clientY: 130 })
      await waitFor(() => expect(content.style.transform).toBe("translate3d(40px, 30px, 0) scale(1)"))
      expect(content.style.transition).toBe("none")

      // and the next move is relative to the last, not to the press
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 150, clientY: 130 })
      await waitFor(() => expect(content.style.transform).toBe("translate3d(50px, 30px, 0) scale(1)"))
      fireEvent.pointerUp(surface, { pointerId: 1, clientX: 150, clientY: 130 })

      // a released pointer no longer moves the diagram
      fireEvent.pointerMove(surface, { pointerId: 1, clientX: 400, clientY: 400 })
      await waitFor(() => expect(content.style.transform).toBe("translate3d(50px, 30px, 0) scale(1)"))
    })

    it("eases the button nudges, which are steps rather than a held position", async () => {
      const { content } = await openDiagram()

      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
      await waitFor(() => expect(content.style.transform).toBe("translate3d(0px, 0px, 0) scale(1.15)"))
      expect(content.style.transition).toBe("transform 150ms ease-out")
    })

    /**
     * A chart zoomed out to fit still needs somewhere to fit INTO, so the
     * bottom edge drags and the height a person picked is what the next
     * diagram opens at.
     */
    it("resizes on the bottom edge and opens the next diagram at that height", async () => {
      const { view } = await openDiagram()
      const handle = screen.getByRole("separator", { name: "Resize diagram" })
      const frame = handle.parentElement as HTMLElement
      expect(frame.style.height).toBe("288px")

      fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientY: 400 })
      fireEvent.pointerMove(handle, { pointerId: 2, clientY: 560 })
      // the frame follows the pointer without a re-render in between
      expect(frame.style.height).toBe("448px")
      fireEvent.pointerUp(handle, { pointerId: 2, clientY: 560 })
      expect(handle).toHaveAttribute("aria-valuenow", "448")

      view.unmount()
      const next = render(<Prose text={FENCE} />)
      fireEvent.click(next.getByRole("button", { name: "Render diagram" }))
      expect(await next.findByRole("separator", { name: "Resize diagram" })).toHaveAttribute("aria-valuenow", "448")
    })

    it("clamps the drag and takes the arrow keys", async () => {
      await openDiagram()
      const handle = screen.getByRole("separator", { name: "Resize diagram" })
      const frame = handle.parentElement as HTMLElement

      fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientY: 400 })
      fireEvent.pointerMove(handle, { pointerId: 3, clientY: -2000 })
      expect(frame.style.height).toBe("160px")
      fireEvent.pointerUp(handle, { pointerId: 3, clientY: -2000 })

      fireEvent.keyDown(handle, { key: "ArrowDown" })
      expect(frame.style.height).toBe("184px")
    })
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

it.each(["https://example.test/marker.png", "http://127.0.0.1:8123/marker.png", "http://192.168.1.1/marker.png"])("requires consent for %s and resets it when streamed URLs change", url => {
  const view = render(<Prose text={`![fixture](${url})`} />)
  expect(view.container.querySelector("img")).toBeNull()
  expect(screen.getByText(url)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Load image" }))
  expect(view.container.querySelector("img")).toHaveAttribute("src", url)
  view.rerender(<Prose text="![fixture](https://other.test/new.png)" />)
  expect(view.container.querySelector("img")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Load image" }))
  fireEvent.error(view.container.querySelector("img")!)
  expect(screen.getByRole("button", { name: "Retry image" })).toBeInTheDocument()
})
