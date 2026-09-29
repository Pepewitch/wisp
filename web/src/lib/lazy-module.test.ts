import { afterEach, describe, expect, it, vi } from "vitest"

/** A fresh copy of the module, built as `mode` builds it. */
async function lazyModuleIn(mode: string) {
  vi.stubEnv("MODE", mode)
  vi.resetModules()
  return (await import("./lazy-module")).lazyModule
}

describe("lazyModule", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("in the browser build, loads on first use, once, and tells whoever is waiting", async () => {
    const lazyModule = await lazyModuleIn("web")
    const importer = vi.fn(() => Promise.resolve("loaded"))
    const module = lazyModule(importer)
    expect(importer).not.toHaveBeenCalled()
    expect(module.current()).toBeNull()

    const listener = vi.fn()
    module.subscribe(listener)
    await Promise.all([module.load(), module.load()])
    await module.load()

    expect(importer).toHaveBeenCalledTimes(1)
    expect(module.current()).toBe("loaded")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("can be asked again after a load fails", async () => {
    const lazyModule = await lazyModuleIn("web")
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("chunk is gone"))
      .mockResolvedValueOnce("loaded")
    const module = lazyModule(importer)

    await expect(module.load()).rejects.toThrow("chunk is gone")
    expect(module.current()).toBeNull()
    await expect(module.load()).resolves.toBe("loaded")
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it("in every other build, asks at once, so the first render already finds it", async () => {
    const lazyModule = await lazyModuleIn("production")
    const importer = vi.fn(() => Promise.resolve("loaded"))
    const module = lazyModule(importer)
    expect(importer).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(module.current()).toBe("loaded"))
  })
})
