import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { initTitleTips } from "./title-tips"

/** jsdom has no hover media query; this is a pointer that can hover. */
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("hover"), media: query }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] })
  initTitleTips()
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function button(title: string): HTMLButtonElement {
  const el = document.createElement("button")
  el.title = title
  el.innerHTML = "<span>icon</span>"
  document.body.appendChild(el)
  return el
}
const over = (el: Element) => el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }))
const out = (el: Element, to: Element | null = document.body) =>
  el.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: to }))
const tip = () => document.querySelector<HTMLElement>("[role=tooltip]")

describe("titles shown as Wisp's own tooltip", () => {
  it("holds the title aside while hovered, shows it after the delay, and gives it back", () => {
    const search = button("Search tasks")
    over(search.firstElementChild!)
    expect(search.hasAttribute("title")).toBe(false)
    expect(tip()?.hidden ?? true).toBe(true)

    vi.advanceTimersByTime(450)
    expect(tip()?.hidden).toBe(false)
    expect(tip()?.textContent).toBe("Search tasks")
    expect(tip()?.dataset.state).toBe("unfold")

    out(search)
    expect(search.getAttribute("title")).toBe("Search tasks")
    expect(tip()?.dataset.state).toBe("out")
  })

  it("opens a neighbour at once, without the unfold, right after one closes", () => {
    const add = button("Add project")
    vi.advanceTimersByTime(200)
    over(add)
    vi.advanceTimersByTime(0)
    expect(tip()?.textContent).toBe("Add project")
    expect(tip()?.dataset.state).toBe("instant")
    out(add)
  })

  it("closes when its control leaves the page under a still pointer", () => {
    vi.advanceTimersByTime(1000)
    const row = button("Archive this task")
    over(row)
    vi.advanceTimersByTime(450)
    expect(tip()?.dataset.state).toBe("unfold")
    row.remove()
    vi.advanceTimersByTime(250)
    expect(tip()?.dataset.state).toBe("out")
  })

  it("never shows a title that is empty, and leaves a touch alone", () => {
    vi.advanceTimersByTime(1000)
    const blank = button("   ")
    over(blank)
    vi.advanceTimersByTime(450)
    expect(blank.getAttribute("title")).toBe("   ")

    const tapped = button("Archive this task")
    tapped.dispatchEvent(Object.assign(new MouseEvent("pointerover", { bubbles: true }), { pointerType: "touch" }))
    expect(tapped.getAttribute("title")).toBe("Archive this task")
  })
})
