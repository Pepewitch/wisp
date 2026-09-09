import { afterEach, expect, it, vi } from "vitest"
const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  save: vi.fn(async () => false),
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }))
vi.mock("./desktop-bridge", () => ({
  desktopBridge: { saveTaskExport: native.save },
}))
import { decodeTaskExport, saveTaskExport } from "./task-export"
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it("uses a native save command in Desktop and preserves cancellation", async () => {
  native.isTauri.mockReturnValue(true)
  expect(await saveTaskExport("tfixture", "{}")).toBe(false)
  expect(native.save).toHaveBeenCalledWith("tfixture", "{}")
})
it("downloads in the browser and releases the temporary URL", async () => {
  native.isTauri.mockReturnValue(false)
  vi.useFakeTimers()
  const create = vi.fn(() => "blob:fixture"),
    revoke = vi.fn()
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke })
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("wisp-task-tfixture.json")
    })
  expect(await saveTaskExport("tfixture", "{}")).toBe(true)
  expect(click).toHaveBeenCalledOnce()
  vi.runAllTimers()
  expect(revoke).toHaveBeenCalledWith("blob:fixture")
})
it("rejects malformed responses before any save", () => {
  expect(() => decodeTaskExport({ format: "unknown" })).toThrow(/incompatible/)
})
