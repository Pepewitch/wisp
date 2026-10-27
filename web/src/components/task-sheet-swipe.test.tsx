import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { MobileShell } from "./mobile-shell"

/** The sheet's height in these tests; jsdom lays nothing out. */
const HEIGHT = 500

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MobileShell
      task={TASKS[0]!}
      sidebar={() => null}
      conversation={<div>Transcript</div>}
      changes={<div>Diff</div>}
      terminal={<div>Shell</div>}
      composer={<div>Composer</div>}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport(), client) },
  )
}

/** One finger, by hand: jsdom has no Touch, and a real timeStamp would make velocity a race. */
function touch(target: Element, type: "touchstart" | "touchmove" | "touchend", y: number, t: number, x = 200): Event {
  const point = { identifier: 1, clientX: x, clientY: y, target }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
    timeStamp: { value: t },
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** Let the drag paint its frame. */
async function frame() {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

const sheet = () => screen.queryByRole("dialog", { name: TASKS[0]!.title })
const backdrop = () => document.querySelector<HTMLElement>(".bg-scrim")
const shown = (text: string) => screen.getByText(text).closest("[aria-hidden]")?.getAttribute("aria-hidden") !== "true"

async function openSheet(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Task sheet" }))
  return await screen.findByRole("dialog", { name: TASKS[0]!.title })
}

/** A slow drag down from y=100 to `to`, ending at rest, so only the distance decides. */
async function slowDrag(target: Element, to: number) {
  touch(target, "touchstart", 100, 0)
  touch(target, "touchmove", 105, 16)
  touch(target, "touchmove", 112, 32)
  touch(target, "touchmove", to, 400)
  await frame()
}

let reducedMotion: boolean | null = null

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("wisp-sheet") ? HEIGHT : 0
    },
  })
  reducedMotion = null
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("reduce") ? reducedMotion ?? true : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  })
  document.documentElement.style.setProperty("--dur-in", "180ms")
  document.documentElement.style.setProperty("--dur-out", "110ms")
})

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
  Reflect.deleteProperty(window, "matchMedia")
  document.documentElement.removeAttribute("style")
})

describe("dragging the task sheet down", () => {
  it("follows a slow downward drag 1:1, the backdrop with it, and never rises past open", async () => {
    mount()
    const popup = await openSheet()

    touch(popup, "touchstart", 100, 0)
    const pending = touch(popup, "touchmove", 105, 16)
    expect(pending.defaultPrevented).toBe(false)
    const claimed = touch(popup, "touchmove", 112, 32)
    expect(claimed.defaultPrevented).toBe(true)
    await frame()
    expect(popup.style.transform).toBe("translateY(12px)")

    touch(popup, "touchmove", 300, 400)
    await frame()
    expect(popup.style.transform).toBe("translateY(200px)")
    expect(popup.style.transition).toBe("none")
    expect(backdrop()!.style.opacity).toBe("0.6")

    touch(popup, "touchmove", 20, 500)
    await frame()
    expect(popup.style.transform).toBe("translateY(0px)")
    expect(backdrop()!.style.opacity).toBe("1")
  })

  it("closes on a release past half its height", async () => {
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 400)
    touch(popup, "touchend", 400, 600)

    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("springs back open from a release short of half with no fling", async () => {
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 300)
    expect(popup.style.transform).toBe("translateY(200px)")
    touch(popup, "touchend", 300, 600)

    expect(sheet()).not.toBeNull()
    expect(popup.style.transform).toBe("")
  })

  it("closes for a short fast fling", async () => {
    mount()
    const popup = await openSheet()
    touch(popup, "touchstart", 100, 0)
    touch(popup, "touchmove", 112, 10)
    touch(popup, "touchmove", 130, 30)
    touch(popup, "touchmove", 150, 50)
    touch(popup, "touchend", 150, 55)

    // 50px of 500 is a tenth of the way, but at ~0.9 px/ms
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("leaves an upward drag alone", async () => {
    mount()
    const popup = await openSheet()
    touch(popup, "touchstart", 300, 0)
    const up = touch(popup, "touchmove", 288, 16)
    const further = touch(popup, "touchmove", 100, 200)
    touch(popup, "touchend", 100, 220)

    expect(up.defaultPrevented).toBe(false)
    expect(further.defaultPrevented).toBe(false)
    expect(sheet()).not.toBeNull()
    expect(popup.style.transform).toBe("")
  })

  it("lets a body scrolled down scroll back up, and closes from one at its top", async () => {
    mount()
    const popup = await openSheet()
    const body = popup.querySelector<HTMLElement>(".overflow-y-auto")!
    // jsdom has no stylesheet for the utility classes
    body.style.overflowY = "auto"
    Object.defineProperties(body, { scrollHeight: { value: 900 }, clientHeight: { value: 400 }, scrollTop: { value: 120, writable: true } })
    const row = within(popup).getByRole("button", { name: /^Changes/ })

    touch(row, "touchstart", 100, 0)
    touch(row, "touchmove", 112, 32)
    const scroll = touch(row, "touchmove", 400, 400)
    touch(row, "touchend", 400, 600)
    expect(scroll.defaultPrevented).toBe(false)
    expect(sheet()).not.toBeNull()
    expect(popup.style.transform).toBe("")

    body.scrollTop = 0
    await slowDrag(row, 400)
    expect(popup.style.transform).toBe("translateY(300px)")
    touch(row, "touchend", 400, 600)
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("leaves a field, an inline popup and a pinched-in page their own touches", async () => {
    mount()
    const popup = await openSheet()
    const body = popup.querySelector<HTMLElement>(".overflow-y-auto")!
    const field = body.appendChild(document.createElement("input"))
    const list = body.appendChild(document.createElement("div"))
    list.setAttribute("role", "listbox")
    const option = list.appendChild(document.createElement("div"))

    for (const target of [field, option]) {
      await slowDrag(target, 400)
      touch(target, "touchend", 400, 600)
      expect(sheet()).not.toBeNull()
      expect(popup.style.transform).toBe("")
    }

    Object.defineProperty(window, "visualViewport", { configurable: true, value: { scale: 2 } })
    try {
      await slowDrag(popup, 400)
      touch(popup, "touchend", 400, 600)
      expect(sheet()).not.toBeNull()
      expect(popup.style.transform).toBe("")
    } finally {
      Reflect.deleteProperty(window, "visualViewport")
    }
  })

  it("tracks a drag on the backdrop too", async () => {
    mount()
    await openSheet()
    const scrim = backdrop()!
    await slowDrag(scrim, 250)
    expect(sheet()!.style.transform).toBe("translateY(150px)")

    touch(scrim, "touchend", 250, 600)
    expect(sheet()).not.toBeNull()
    expect(sheet()!.style.transform).toBe("")
  })

  it("is the only thing that can close the sheet while the drag holds it", async () => {
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 200)
    fireEvent.keyDown(popup, { key: "Escape" })
    expect(sheet()).not.toBeNull()

    touch(popup, "touchend", 200, 600)
    expect(sheet()).not.toBeNull()
  })
})

describe("taps on the sheet", () => {
  it("still open a row's tool: a tap is never a drag", async () => {
    mount()
    const popup = await openSheet()
    const row = within(popup).getByRole("button", { name: /^Changes/ })
    touch(row, "touchstart", 300, 0)
    const jitter = touch(row, "touchmove", 304, 40)
    touch(row, "touchend", 304, 80)
    fireEvent.click(row)

    expect(jitter.defaultPrevented).toBe(false)
    expect(shown("Diff")).toBe(true)
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("closes on Esc as before", async () => {
    mount()
    const popup = await openSheet()
    fireEvent.keyDown(popup, { key: "Escape" })

    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("opens again at rest after a drag closed it", async () => {
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 400)
    touch(popup, "touchend", 400, 600)
    await waitFor(() => expect(sheet()).toBeNull())

    expect((await openSheet()).style.transform).toBe("")
  })
})

describe("the sheet's settle", () => {
  it("slides the rest of the way down on --dur-out, paced by what is left, before it closes", async () => {
    reducedMotion = false
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 400)
    touch(popup, "touchend", 400, 600)

    // 200px of 500 left at --dur-out's 110ms for the whole height
    expect(popup.style.transition).toBe("transform 44ms var(--ease-out)")
    expect(popup.style.transform).toBe(`translateY(${HEIGHT}px)`)
    expect(backdrop()!.style.opacity).toBe("0")
    expect(sheet()).not.toBeNull()
    await waitFor(() => expect(sheet()).toBeNull())
  })

  it("springs back on --dur-in", async () => {
    reducedMotion = false
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 200)
    touch(popup, "touchend", 200, 600)

    // 100px of 500 back at --dur-in's 180ms for the whole height
    expect(popup.style.transition).toBe("transform 36ms var(--ease-out)")
    expect(popup.style.transform).toBe("translateY(0px)")
    await waitFor(() => expect(popup.style.transform).toBe(""))
  })

  it("snaps under reduced motion", async () => {
    reducedMotion = true
    mount()
    const popup = await openSheet()
    await slowDrag(popup, 400)
    touch(popup, "touchend", 400, 600)

    expect(popup.style.transition).toBe("none")
    expect(popup.style.transform).toBe(`translateY(${HEIGHT}px)`)
    await waitFor(() => expect(sheet()).toBeNull())
  })
})
