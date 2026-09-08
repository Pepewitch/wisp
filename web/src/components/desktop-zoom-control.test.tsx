import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DesktopZoomProvider } from "@/lib/desktop-zoom"

import { DesktopZoomControl } from "./desktop-zoom-control"

const native = vi.hoisted(() => ({
  setZoom: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: native.setZoom }),
}))

const ZOOM_SETTING = "wisp.desktop.zoom-percent"

function renderControl() {
  render(
    <DesktopZoomProvider>
      <DesktopZoomControl />
    </DesktopZoomProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  native.setZoom.mockClear()
})

afterEach(() => vi.restoreAllMocks())

describe("Desktop zoom control", () => {
  it("applies, displays, and persists zoom changes", async () => {
    renderControl()

    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1))
    fireEvent.click(screen.getByRole("button", { name: "Zoom, 100%" }))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))

    expect(
      screen.getByRole("status", { name: "Zoom level" })
    ).toHaveTextContent("110%")
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1.1))
    expect(localStorage.getItem(ZOOM_SETTING)).toBe("110")
    expect(
      screen.getByRole("button", { name: "Zoom, 110%" })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Reset" }))
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1))
    expect(localStorage.getItem(ZOOM_SETTING)).toBe("100")
  })

  it("handles desktop zoom shortcuts and prevents browser zoom", async () => {
    renderControl()
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1))

    const zoomIn = new KeyboardEvent("keydown", {
      key: "=",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(zoomIn)
    expect(zoomIn.defaultPrevented).toBe(true)
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1.1))

    const zoomOut = new KeyboardEvent("keydown", {
      key: "-",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(zoomOut)
    expect(zoomOut.defaultPrevented).toBe(true)
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1))

    const unrelatedControlShortcut = new KeyboardEvent("keydown", {
      key: "_",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(unrelatedControlShortcut)
    expect(unrelatedControlShortcut.defaultPrevented).toBe(false)
    expect(native.setZoom).toHaveBeenCalledTimes(3)

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "+",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1.1))

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "0",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(1))
  })

  it("survives unavailable storage and deduplicates StrictMode startup", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("Storage is unavailable")
    })

    render(
      <StrictMode>
        <DesktopZoomProvider>
          <DesktopZoomControl />
        </DesktopZoomProvider>
      </StrictMode>
    )

    await waitFor(() => expect(native.setZoom).toHaveBeenCalledWith(1))
    expect(native.setZoom).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole("button", { name: "Zoom, 100%" })
    ).toBeInTheDocument()
  })

  it("restores a bounded persisted level", async () => {
    localStorage.setItem(ZOOM_SETTING, "350")
    renderControl()

    await waitFor(() => expect(native.setZoom).toHaveBeenLastCalledWith(2))
    fireEvent.click(screen.getByRole("button", { name: "Zoom, 200%" }))

    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(
      screen.getByRole("status", { name: "Zoom level" })
    ).toHaveTextContent("200%")
    expect(localStorage.getItem(ZOOM_SETTING)).toBe("200")
  })
})
