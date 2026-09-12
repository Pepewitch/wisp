import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

// The terminal pane imports xterm's stylesheet as a STRING (`?inline`) and
// injects it once at runtime, so the bundle stays self-contained. jsdom has no
// CSS engine; mock both specifiers — vitest matches them literally, so the
// bare path alone would leave the `?inline` import unmocked.
vi.mock("@xterm/xterm/css/xterm.css", () => ({}))
vi.mock("@xterm/xterm/css/xterm.css?inline", () => ({ default: "" }))

// vitest runs without globals here, so register the DOM teardown explicitly
afterEach(cleanup)

// jsdom has no ResizeObserver; react-resizable-panels constructs one per
// group at mount, so the pane tests need this no-op stub
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// jsdom has no scrollIntoView; cmdk (the S3 slash palette) calls it whenever
// the selection moves
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom implements none of pointer capture, which every drag surface in the
// app takes on press — the mermaid viewer's pan and its height handle. Track
// the ids so `hasPointerCapture` answers honestly rather than always false.
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>()
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    const ids = captured.get(this) ?? new Set<number>()
    ids.add(id)
    captured.set(this, ids)
  }
  Element.prototype.releasePointerCapture = function releasePointerCapture(id: number) {
    captured.get(this)?.delete(id)
  }
  Element.prototype.hasPointerCapture = function hasPointerCapture(id: number) {
    return captured.get(this)?.has(id) ?? false
  }
}
