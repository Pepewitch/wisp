import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { MobileShell } from "./mobile-shell"

/** The drawer's width in these tests; jsdom lays nothing out. */
const WIDTH = 300

function mount(conversation = <div>Transcript</div>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MobileShell
      task={TASKS[0]!}
      sidebar={(dismiss) => <button type="button" onClick={dismiss}>Pick a task</button>}
      conversation={conversation}
      changes={<div>Diff</div>}
      terminal={<div>Shell</div>}
      composer={<textarea aria-label="Composer" />}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport(), client) },
  )
}

/** One finger, by hand: jsdom has no Touch, and a real timeStamp would make velocity a race. */
function touch(target: Element, type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, t: number, y = 400): Event {
  const point = { identifier: 1, clientX: x, clientY: y, target }
  const event = new Event(type, { bubbles: true, cancelable: true })
  const lifted = type === "touchend" || type === "touchcancel"
  Object.defineProperties(event, {
    touches: { value: lifted ? [] : [point] },
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

const drawer = () => screen.queryByRole("dialog", { name: "Tasks" })
const backdrop = () => document.querySelector<HTMLElement>(".bg-scrim")

/** A slow drag from x=50 to `to`, ending at rest, so only the distance decides. */
async function slowDrag(target: Element, to: number) {
  touch(target, "touchstart", 50, 0)
  touch(target, "touchmove", 55, 16)
  touch(target, "touchmove", 62, 32)
  touch(target, "touchmove", to, 400)
  await frame()
}

let reducedMotion: boolean | null = null

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("mobile-task-drawer") ? WIDTH : 0
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
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth")
  Reflect.deleteProperty(window, "matchMedia")
  document.documentElement.removeAttribute("style")
})

describe("swiping the phone drawer open", () => {
  it("follows a slow rightward drag 1:1, the backdrop with it", async () => {
    mount()
    const transcript = screen.getByText("Transcript")

    touch(transcript, "touchstart", 50, 0)
    touch(transcript, "touchmove", 55, 16)
    expect(drawer()).toBeNull()
    const claimed = touch(transcript, "touchmove", 62, 32)
    expect(claimed.defaultPrevented).toBe(true)
    // mounted under the finger rather than at rest: 12px of the drawer showing
    expect(drawer()!.style.transform).toBe("translateX(-288px)")

    touch(transcript, "touchmove", 110, 200)
    await frame()
    expect(drawer()!.style.transform).toBe("translateX(-240px)")
    expect(drawer()!.style.transition).toBe("none")
    expect(backdrop()!.style.opacity).toBe("0.2")

    touch(transcript, "touchmove", 170, 400)
    await frame()
    expect(drawer()!.style.transform).toBe("translateX(-180px)")
    expect(backdrop()!.style.opacity).toBe("0.4")

    // never past fully open
    touch(transcript, "touchmove", 600, 500)
    await frame()
    expect(drawer()!.style.transform).toBe("translateX(0px)")
  })

  it("opens on a release past half way", async () => {
    mount()
    const transcript = screen.getByText("Transcript")
    await slowDrag(transcript, 230)
    touch(transcript, "touchend", 230, 600)

    expect(drawer()).not.toBeNull()
    // settled, and handed back to the stylesheet
    expect(drawer()!.style.transform).toBe("")
  })

  it("closes again on a release short of half way with no fling", async () => {
    mount()
    const transcript = screen.getByText("Transcript")
    await slowDrag(transcript, 170)
    touch(transcript, "touchend", 170, 600)

    await waitFor(() => expect(drawer()).toBeNull())
  })

  it("opens for a short fast fling", async () => {
    mount()
    const transcript = screen.getByText("Transcript")
    touch(transcript, "touchstart", 50, 0)
    touch(transcript, "touchmove", 62, 10)
    touch(transcript, "touchmove", 80, 30)
    touch(transcript, "touchmove", 100, 50)
    touch(transcript, "touchend", 100, 55)

    // 50px of 300 is a sixth of the way, but at ~0.9 px/ms
    expect(drawer()).not.toBeNull()
  })

  it("leaves a vertical drag to the browser", () => {
    mount()
    const transcript = screen.getByText("Transcript")
    touch(transcript, "touchstart", 100, 0, 400)
    const scroll = touch(transcript, "touchmove", 104, 16, 380)
    const sideways = touch(transcript, "touchmove", 220, 200, 380)
    touch(transcript, "touchend", 220, 220, 380)

    expect(scroll.defaultPrevented).toBe(false)
    expect(sideways.defaultPrevented).toBe(false)
    expect(drawer()).toBeNull()
  })

  it("leaves a code block that can still scroll left to scroll, and opens from one that cannot", async () => {
    mount(<pre data-testid="code" style={{ overflowX: "auto" }}><code>const wide = true</code></pre>)
    const code = screen.getByTestId("code")
    Object.defineProperties(code, { scrollWidth: { value: 900 }, clientWidth: { value: 300 }, scrollLeft: { value: 120, writable: true } })

    await slowDrag(code.firstElementChild!, 230)
    touch(code.firstElementChild!, "touchend", 230, 600)
    expect(drawer()).toBeNull()

    code.scrollLeft = 0
    await slowDrag(code.firstElementChild!, 230)
    touch(code.firstElementChild!, "touchend", 230, 600)
    expect(drawer()).not.toBeNull()
  })

  it("leaves the composer's text area alone", async () => {
    mount()
    const composer = screen.getByRole("textbox", { name: "Composer" })
    await slowDrag(composer, 230)
    touch(composer, "touchend", 230, 600)

    expect(drawer()).toBeNull()
  })

  it("takes no mouse drag, which stays a text selection", () => {
    mount()
    const transcript = screen.getByText("Transcript")
    fireEvent.pointerDown(transcript, { pointerType: "mouse", clientX: 50, clientY: 400 })
    fireEvent.pointerMove(transcript, { pointerType: "mouse", clientX: 250, clientY: 400 })
    fireEvent.pointerUp(transcript, { pointerType: "mouse", clientX: 250, clientY: 400 })

    expect(drawer()).toBeNull()
  })

  it("is the only thing that can close the drawer while the drag holds it", async () => {
    mount()
    const transcript = screen.getByText("Transcript")
    await slowDrag(transcript, 230)
    fireEvent.click(screen.getByRole("button", { name: "Pick a task" }))
    expect(drawer()).not.toBeNull()

    touch(transcript, "touchend", 230, 600)
    expect(drawer()).not.toBeNull()
  })
})

describe("dragging the open drawer shut", () => {
  async function openByHamburger(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "Open tasks" }))
    return await screen.findByRole("dialog", { name: "Tasks" })
  }

  it("tracks a leftward drag on the drawer and closes past half way", async () => {
    mount()
    const popup = await openByHamburger()
    touch(popup, "touchstart", 250, 0)
    touch(popup, "touchmove", 238, 16)
    await frame()
    expect(popup.style.transform).toBe("translateX(-12px)")

    touch(popup, "touchmove", 90, 400)
    await frame()
    expect(popup.style.transform).toBe("translateX(-160px)")
    expect(backdrop()!.style.opacity).toBe(String((WIDTH - 160) / WIDTH))

    touch(popup, "touchend", 90, 600)
    await waitFor(() => expect(drawer()).toBeNull())
  })

  it("springs back open from a short drag on the backdrop", async () => {
    mount()
    await openByHamburger()
    const scrim = backdrop()!
    touch(scrim, "touchstart", 360, 0)
    touch(scrim, "touchmove", 340, 16)
    touch(scrim, "touchmove", 300, 400)
    await frame()
    expect(drawer()!.style.transform).toBe("translateX(-60px)")

    touch(scrim, "touchend", 300, 600)
    expect(drawer()).not.toBeNull()
    expect(drawer()!.style.transform).toBe("")
  })
})

describe("the drawer's settle", () => {
  it("animates the rest of the way on the motion tokens, paced by what is left", async () => {
    reducedMotion = false
    mount()
    const transcript = screen.getByText("Transcript")
    await slowDrag(transcript, 230)
    touch(transcript, "touchend", 230, 600)

    // 120px of 300 left at --dur-in's 180ms for the whole width
    expect(drawer()!.style.transition).toBe("transform 72ms var(--ease-out)")
    expect(drawer()!.style.transform).toBe("translateX(0px)")
    expect(backdrop()!.style.transition).toBe("opacity 72ms var(--ease-out)")
    expect(backdrop()!.style.opacity).toBe("1")
    await waitFor(() => expect(drawer()!.style.transform).toBe(""))
  })

  it("slides a drawer dragged shut out of sight before it closes", async () => {
    reducedMotion = false
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Open tasks" }))
    const popup = await screen.findByRole("dialog", { name: "Tasks" })
    touch(popup, "touchstart", 250, 0)
    touch(popup, "touchmove", 238, 16)
    touch(popup, "touchmove", 90, 400)
    await frame()
    touch(popup, "touchend", 90, 600)

    // 140px of 300 left at --dur-out's 110ms for the whole width
    expect(popup.style.transition).toBe("transform 51ms var(--ease-out)")
    expect(popup.style.transform).toBe("translateX(-300px)")
    expect(drawer()).not.toBeNull()
    await waitFor(() => expect(drawer()).toBeNull())
  })

  it("snaps under reduced motion", async () => {
    reducedMotion = true
    mount()
    const transcript = screen.getByText("Transcript")
    await slowDrag(transcript, 230)
    touch(transcript, "touchend", 230, 600)

    expect(drawer()!.style.transition).toBe("")
    expect(drawer()!.style.transform).toBe("")
  })
})

describe("the hamburger", () => {
  it("still opens the drawer, and the sidebar's own dismiss still closes it", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Open tasks" }))
    expect(await screen.findByRole("dialog", { name: "Tasks" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Pick a task" }))
    await waitFor(() => expect(drawer()).toBeNull())
  })
})
