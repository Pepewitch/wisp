import { act, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useMobileViewport } from "./use-mobile-viewport"

afterEach(() => vi.unstubAllGlobals())

function Shell({ enabled = true }: { enabled?: boolean }) {
  const ref = useMobileViewport(enabled)
  return <div ref={ref} data-testid="shell" />
}

it("keeps the composer within the keyboard viewport, respects zoom and cleans up listeners", () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 })
  vi.stubGlobal("visualViewport", viewport)
  vi.stubGlobal("innerHeight", 800)
  const view = render(<Shell />)
  const shell = view.getByTestId("shell")
  expect(shell.style.getPropertyValue("--mobile-height")).toBe("800px")
  expect(shell.style.getPropertyValue("--mobile-viewport-extension")).toBe("")
  act(() => {
    viewport.height = 460
    viewport.offsetTop = 30
    viewport.dispatchEvent(new Event("resize"))
  })
  expect(shell.style.getPropertyValue("--mobile-height")).toBe("460px")
  expect(shell.style.getPropertyValue("--mobile-top")).toBe("30px")
  expect(shell.style.getPropertyValue("--mobile-bottom")).toBe("0px")
  expect(shell.style.getPropertyValue("--mobile-viewport-extension")).toBe("0px")
  act(() => {
    viewport.height = 800
    viewport.offsetTop = 0
    viewport.dispatchEvent(new Event("resize"))
  })
  expect(shell.style.getPropertyValue("--mobile-viewport-extension")).toBe("")
  act(() => { viewport.scale = 2; viewport.height = 230; viewport.dispatchEvent(new Event("resize")) })
  expect(shell.style.getPropertyValue("--mobile-height")).toBe("800px")
  view.unmount()
  act(() => { viewport.scale = 1; viewport.dispatchEvent(new Event("resize")) })
  expect(shell.style.getPropertyValue("--mobile-height")).toBe("")
})

it("leaves Desktop window sizing to the native shell", () => {
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { height: 400, offsetTop: 20, scale: 1 }))
  const view = render(<Shell enabled={false} />)
  expect(view.getByTestId("shell").style.length).toBe(0)
})
