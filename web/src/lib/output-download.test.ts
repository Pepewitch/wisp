import { afterEach, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ enabled: false, save: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }))
vi.mock("./desktop-bridge", () => ({ desktopBridge: { saveOutputImage: native.save } }))
import { saveOutputImage } from "./output-download"

afterEach(() => { native.enabled = false; vi.unstubAllGlobals(); vi.restoreAllMocks(); native.save.mockReset() })

it("Desktop fetches from the initiating proxy and sends bounded image bytes to the native Save panel", async () => {
  native.enabled = true
  native.save.mockResolvedValue(true)
  const fetch = vi.fn().mockResolvedValue(new Response("synthetic", { headers: { "content-type": "image/png" } }))
  vi.stubGlobal("fetch", fetch)
  const src = "http://127.0.0.1:9/cap/connections/remote-one/7/api/tasks/tfixture/outputs/1/abc"
  expect(await saveOutputImage("plot.png", src)).toBe(true)
  expect(fetch).toHaveBeenCalledWith(src, expect.objectContaining({ credentials: "omit", redirect: "error" }))
  expect(native.save).toHaveBeenCalledWith("plot.png", btoa("synthetic"))
})

it("Desktop names unavailable images and never opens a Save panel for oversized bytes", async () => {
  native.enabled = true
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("gone", { status: 410 })).mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1))))
  await expect(saveOutputImage("plot.png", "http://fixture/output")).rejects.toThrow("Image unavailable")
  await expect(saveOutputImage("plot.png", "http://fixture/output")).rejects.toThrow("8 MiB")
  expect(native.save).not.toHaveBeenCalled()
})

it("Desktop treats cancelling its Save panel as a normal result", async () => {
  native.enabled = true
  native.save.mockResolvedValue(false)
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic")))
  expect(await saveOutputImage("plot.png", "http://fixture/output")).toBe(false)
})
