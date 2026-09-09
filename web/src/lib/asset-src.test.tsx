import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearAssetCache, useAssetSrc } from "./asset-src"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

const PATH = "/api/tasks/t1/attachments/1/shot.png"

beforeEach(() => {
  clearAssetCache()
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}-${Math.random()}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useAssetSrc", () => {
  /**
   * The desktop path. Its native proxy authenticates the media hop, so the URL
   * is usable as-is and must not be turned into a fetch — that would be a
   * pointless copy of every screenshot through JavaScript.
   */
  it("passes a transport URL straight through when there is no fetchAsset", () => {
    const transport = fakeDaemonTransport("desktop-one", {
      assetUrl: (path) => `http://127.0.0.1:9/connections/one/0${path}`,
    })
    const { result } = renderHook(() => useAssetSrc(PATH), {
      wrapper: runtimeWrapper(transport),
    })
    expect(result.current).toBe(`http://127.0.0.1:9/connections/one/0${PATH}`)
  })

  it("fetches with the transport and renders a blob URL", async () => {
    const fetchAsset = vi.fn().mockResolvedValue(new Blob(["bytes"]))
    const transport = fakeDaemonTransport("local", { fetchAsset })
    const { result } = renderHook(() => useAssetSrc(PATH), {
      wrapper: runtimeWrapper(transport),
    })

    // Nothing is rendered from an unauthenticated URL in the meantime.
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toMatch(/^blob:/))
    expect(fetchAsset).toHaveBeenCalledWith(PATH)
  })

  it("fetches one path once, however many components show it", async () => {
    const fetchAsset = vi.fn().mockResolvedValue(new Blob(["bytes"]))
    const transport = fakeDaemonTransport("local", { fetchAsset })
    const wrapper = runtimeWrapper(transport)

    const first = renderHook(() => useAssetSrc(PATH), { wrapper })
    await waitFor(() => expect(first.result.current).toMatch(/^blob:/))
    const second = renderHook(() => useAssetSrc(PATH), { wrapper })
    await waitFor(() => expect(second.result.current).toBe(first.result.current))

    expect(fetchAsset).toHaveBeenCalledTimes(1)
  })

  /** Two daemons can hold the same task id; their attachments are not the same bytes. */
  it("keys the cache by connection", async () => {
    const fetchAsset = vi
      .fn()
      .mockResolvedValueOnce(new Blob(["one"]))
      .mockResolvedValueOnce(new Blob(["two-two"]))

    const first = renderHook(() => useAssetSrc(PATH), {
      wrapper: runtimeWrapper(fakeDaemonTransport("daemon-a", { fetchAsset })),
    })
    await waitFor(() => expect(first.result.current).toMatch(/^blob:/))
    const second = renderHook(() => useAssetSrc(PATH), {
      wrapper: runtimeWrapper(fakeDaemonTransport("daemon-b", { fetchAsset })),
    })
    await waitFor(() => expect(second.result.current).toMatch(/^blob:/))

    expect(fetchAsset).toHaveBeenCalledTimes(2)
    expect(second.result.current).not.toBe(first.result.current)
  })

  /**
   * Eviction past the cap used to revoke the oldest URL unconditionally, which
   * in a long transcript could blank a thumbnail that was still on screen (a
   * review's note). A mounted asset is skipped instead.
   */
  it("never revokes an asset that a mounted component is still rendering", async () => {
    const fetchAsset = vi.fn().mockImplementation(() => Promise.resolve(new Blob(["bytes"])))
    const transport = fakeDaemonTransport("local", { fetchAsset })
    const wrapper = runtimeWrapper(transport)

    // one image stays mounted while far more than the cache cap scroll past
    const held = renderHook(() => useAssetSrc("/api/tasks/t1/attachments/1/held.png"), { wrapper })
    await waitFor(() => expect(held.result.current).toMatch(/^blob:/))
    const heldSrc = held.result.current

    for (let index = 0; index < 40; index++) {
      const passing = renderHook(
        () => useAssetSrc(`/api/tasks/t1/attachments/1/scrolled-${index}.png`),
        { wrapper },
      )
      await waitFor(() => expect(passing.result.current).toMatch(/^blob:/))
      passing.unmount()
    }

    expect(vi.mocked(URL.revokeObjectURL).mock.calls.flat()).not.toContain(heldSrc)
    expect(held.result.current).toBe(heldSrc)
  })

  it("renders nothing when the fetch is refused", async () => {
    const fetchAsset = vi.fn().mockRejectedValue(new Error("410"))
    const transport = fakeDaemonTransport("local", { fetchAsset })
    const { result } = renderHook(() => useAssetSrc(PATH), {
      wrapper: runtimeWrapper(transport),
    })
    await waitFor(() => expect(fetchAsset).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it("fetches nothing for a closed viewer", () => {
    const fetchAsset = vi.fn()
    const transport = fakeDaemonTransport("local", { fetchAsset })
    const { result } = renderHook(() => useAssetSrc(null), {
      wrapper: runtimeWrapper(transport),
    })
    expect(result.current).toBeNull()
    expect(fetchAsset).not.toHaveBeenCalled()
  })
})
