import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import * as safety from "@/lib/mermaid-safety"
import { DEFAULT_THEME_PREFERENCE, themeStore } from "@/lib/theme"

import { Prose } from "./prose"

const renderDiagram = vi.hoisted(() => vi.fn())
const getMermaid = vi.hoisted(() => vi.fn())
const getDiagramFromText = vi.hoisted(() => vi.fn())
vi.mock("@streamdown/mermaid", () => ({
  mermaid: { name: "mermaid", type: "diagram", language: "mermaid", getMermaid },
}))
const parseDiagram = vi.hoisted(() => vi.fn())
vi.mock("mermaid", () => ({ default: { mermaidAPI: { getDiagramFromText, parse: parseDiagram } } }))
// the real sanitizer, spied so one test can let an anchor through to the viewer
vi.mock("@/lib/mermaid-safety", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mermaid-safety")>()
  return { ...real, sanitizeMermaidSvg: vi.fn(real.sanitizeMermaidSvg) }
})

const FENCE = "```mermaid\nflowchart TD\n    a --> b\n```"
const EVIL = "https://evil.example"

/**
 * An agent's diagram is rendered with no click from anyone, so it is held to
 * what a rendered Markdown image is: nothing fetched, nothing navigated.
 */
describe("a hostile mermaid fence", () => {
  beforeEach(() => {
    renderDiagram.mockReset()
    getMermaid.mockReset()
    getMermaid.mockImplementation(() => ({ render: renderDiagram }))
    getDiagramFromText.mockReset()
    getDiagramFromText.mockResolvedValue({ db: {} })
    parseDiagram.mockReset()
    parseDiagram.mockResolvedValue({ diagramType: "flowchart-v2", config: {} })
    vi.mocked(safety.sanitizeMermaidSvg).mockClear()
    localStorage.clear()
    themeStore.set(DEFAULT_THEME_PREFERENCE)
  })

  it("renders with a config a diagram's directives cannot loosen", async () => {
    renderDiagram.mockResolvedValue({ svg: "<svg></svg>" })
    render(<Prose text={FENCE} />)
    await screen.findByRole("application", { name: "Mermaid diagram" })
    const config = getMermaid.mock.lastCall?.[0] as Record<string, unknown>
    expect(config).toMatchObject({ securityLevel: "strict", theme: "base" })
    expect(config.secure).toEqual(expect.arrayContaining(["htmlLabels", "dompurifyConfig", "themeCSS"]))
    expect(config.dompurifyConfig).toEqual(safety.MERMAID_SAFE_CONFIG.dompurifyConfig)
  })

  it("puts no remote image, form or link from the SVG into the page", async () => {
    renderDiagram.mockResolvedValue({
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg"><g data-test="node">` +
        `<image href="${EVIL}/shape.png"></image>` +
        `<a xlink:href="${EVIL}/click"><rect width="10" height="10"></rect></a>` +
        `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="${EVIL}/label.png">` +
        `<form action="${EVIL}/f"><input name="q"></form></div></foreignObject></g></svg>`,
    })
    const { container } = render(<Prose text={FENCE} />)
    const surface = await screen.findByRole("application", { name: "Mermaid diagram" })

    expect(surface.querySelector("[data-test='node']")).not.toBeNull()
    expect(container.querySelector("img, a, form, input")).toBeNull()
    expect(container.innerHTML).not.toContain("evil.example")
  })

  it("leaves a diagram with a remote image shape as its source", async () => {
    getDiagramFromText.mockResolvedValue({
      db: { getVertices: () => new Map([["a", { id: "a", img: `${EVIL}/shape.png` }]]) },
    })
    renderDiagram.mockResolvedValue({ svg: "<svg></svg>" })
    const { container } = render(<Prose text={FENCE} />)

    await waitFor(() => expect(getDiagramFromText).toHaveBeenCalled())
    // mermaid's render is what fetches the image, so it must never be reached
    expect(renderDiagram).not.toHaveBeenCalled()
    expect(screen.queryByRole("application", { name: "Mermaid diagram" })).toBeNull()
    expect(container.querySelector("pre")?.textContent).toContain("a --> b")
    fireEvent.click(screen.getByRole("button", { name: "Render diagram" }))
    expect(await screen.findByText(/from the network/)).toBeInTheDocument()
  })

  /** Class and state diagrams apply `style`/`classDef` CSS themselves, during layout. */
  it.each([
    ["a class style", `classDiagram\n  class K1\n  style K1 fill:url(${EVIL}/classstyle)`],
    ["a state classDef", `stateDiagram-v2\n  [*] --> S1\n  classDef bad background-image:url(${EVIL}/s.png)\n  class S1 bad`],
  ])("leaves a diagram with %s that loads a URL as its source", async (_, diagram) => {
    renderDiagram.mockResolvedValue({ svg: "<svg></svg>" })
    const { container } = render(<Prose text={"```mermaid\n" + diagram + "\n```"} />)

    await waitFor(() => expect(parseDiagram).toHaveBeenCalled())
    expect(renderDiagram).not.toHaveBeenCalled()
    expect(container.querySelector("pre")?.textContent).toContain("url(")
  })

  /** The second line: an anchor that got past the sanitizer still cannot navigate. */
  it("opens a surviving diagram link outside the app instead of navigating the window", async () => {
    vi.mocked(safety.sanitizeMermaidSvg).mockImplementation((svg) => svg)
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    renderDiagram.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="${EVIL}/click"><rect data-test="target"></rect></a>` +
        `<a href="/relative"><rect data-test="relative"></rect></a></svg>`,
    })
    const { container } = render(<Prose text={FENCE} />)
    await screen.findByRole("application", { name: "Mermaid diagram" })

    const target = container.querySelector("[data-test='target']")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    target.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith(`${EVIL}/click`, "_blank", "noopener,noreferrer")

    // a relative href would resolve against the app itself: cancelled, not opened
    const relative = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    container.querySelector("[data-test='relative']")!.dispatchEvent(relative)
    expect(relative.defaultPrevented).toBe(true)
    // and a middle click is cancelled too, rather than opening a tab of its own
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    target.dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    open.mockRestore()
  })
})
