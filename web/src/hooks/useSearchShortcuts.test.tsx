import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useSearchShortcuts } from "./useSearchShortcuts"
import { inertProjectSearch } from "@/test/project-search"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * ⌘F and ⌘⇧F are taken from the browser deliberately: the native find sees
 * only what the transcript rendered and cannot answer "and which other task
 * said this". A BARE key would break the composer's palette contract (§5e);
 * a ⌘ chord is never in the set the textarea forwards.
 */
const intents = uiIntentsFor("shortcut-test")

function mount(search = inertProjectSearch({ request: vi.fn() })) {
  function Harness() {
    useSearchShortcuts(intents, search)
    return null
  }
  render(<Harness />)
  return search
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true })
  window.dispatchEvent(event)
  return event
}

describe("the search chords", () => {
  it("opens find-in-task on ⌘F and keeps the key from the browser", () => {
    mount()
    const before = intents.findRequest()?.seq ?? 0

    const event = press({ key: "f", metaKey: true })

    expect(intents.findRequest()?.seq).toBe(before + 1)
    expect(event.defaultPrevented).toBe(true)
  })

  it("opens the project search on ⌘⇧F, and only that", () => {
    const search = mount()
    const before = intents.findRequest()?.seq ?? 0

    press({ key: "F", metaKey: true, shiftKey: true })

    expect(search.request).toHaveBeenCalledOnce()
    expect(intents.findRequest()?.seq).toBe(before)
  })

  it("answers Ctrl+F too, for a keyboard that has no ⌘", () => {
    mount()
    const before = intents.findRequest()?.seq ?? 0

    press({ key: "f", ctrlKey: true })

    expect(intents.findRequest()?.seq).toBe(before + 1)
  })

  it("leaves a bare f and an ⌥ chord alone", () => {
    const search = mount()
    const before = intents.findRequest()?.seq ?? 0

    press({ key: "f" })
    press({ key: "f", metaKey: true, altKey: true })

    expect(intents.findRequest()?.seq).toBe(before)
    expect(search.request).not.toHaveBeenCalled()
  })

  it("leaves ⌘⇧F alone where the daemon cannot answer it", () => {
    const search = mount(inertProjectSearch({ available: false, request: vi.fn() }))
    const before = intents.findRequest()?.seq ?? 0

    press({ key: "F", metaKey: true, shiftKey: true })
    expect(search.request).not.toHaveBeenCalled()

    // ⌘F is client-side, so it still works against any daemon
    press({ key: "f", metaKey: true })
    expect(intents.findRequest()?.seq).toBe(before + 1)
  })

  it("stops listening once the shell unmounts", () => {
    function Harness() {
      useSearchShortcuts(intents, inertProjectSearch())
      return null
    }
    const view = render(<Harness />)
    view.unmount()
    const before = intents.findRequest()?.seq ?? 0

    press({ key: "f", metaKey: true })

    expect(intents.findRequest()?.seq).toBe(before)
  })
})
