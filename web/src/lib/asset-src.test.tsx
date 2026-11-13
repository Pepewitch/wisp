import { act, render, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearAssetCache, refreshAssets, useAssetSrc, useAssetStatus, type AssetStatus } from "./asset-src"
import type { DaemonTransport } from "./transport"
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

it("revokes visible bytes and rejects a stale fetch after task invalidation", async () => {
  let resolveOld!: (blob: Blob) => void
  const fetchAsset = vi.fn().mockImplementationOnce(() => new Promise<Blob>(resolve => { resolveOld = resolve }))
    .mockRejectedValue(new Error("410"))
  const { result } = renderHook(() => useAssetSrc(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(1))
  act(() => clearAssetCache("local", "/api/tasks/t1/"))
  await act(async () => resolveOld(new Blob(["deleted secret"])))
  expect(result.current).toBeNull()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it("invalidates only the selected connection and revokes already displayed assets", async () => {
  const fetchAsset = vi.fn().mockResolvedValueOnce(new Blob(["secret"])).mockRejectedValue(new Error("404"))
  const view = renderHook(() => useAssetSrc(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("one", { fetchAsset })) })
  await waitFor(() => expect(view.result.current).toMatch(/^blob:/))
  const original = view.result.current
  act(() => clearAssetCache("two", "/api/tasks/t1/"))
  expect(view.result.current).toBe(original)
  act(() => clearAssetCache("one", "/api/tasks/t1/"))
  expect(view.result.current).toBeNull()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original)
})

it("evicts oversized cached bytes once their last viewer unmounts", async () => {
  const fetchAsset = vi.fn().mockResolvedValue({ size: 65 * 1024 * 1024 })
  const view = renderHook(() => useAssetSrc(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(view.result.current).toMatch(/^blob:/))
  const original = view.result.current
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original)
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original)
})

/** A refresh keeps the card's bytes on screen until the daemon answers; it never collapses it. */
it("keeps showing the previous bytes while a refresh refetches, then swaps them", async () => {
  let resolveNext!: (blob: Blob) => void
  const fetchAsset = vi.fn().mockResolvedValueOnce(new Blob(["first"]))
    .mockImplementationOnce(() => new Promise<Blob>((resolve) => { resolveNext = resolve }))
  const view = renderHook(() => useAssetSrc(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(view.result.current).toMatch(/^blob:/))
  const original = view.result.current

  act(() => refreshAssets("local", "/api/tasks/t1/"))
  await waitFor(() => expect(fetchAsset).toHaveBeenCalledTimes(2))
  expect(view.result.current).toBe(original)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original)

  await act(async () => resolveNext(new Blob(["second"])))
  expect(view.result.current).toMatch(/^blob:/)
  expect(view.result.current).not.toBe(original)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original)
})

it("drops the previous bytes when a refresh finds them deleted", async () => {
  const fetchAsset = vi.fn().mockResolvedValueOnce(new Blob(["first"])).mockRejectedValue(new Error("410"))
  const view = renderHook(() => useAssetStatus(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(view.result.current.src).toMatch(/^blob:/))
  const original = view.result.current.src
  act(() => refreshAssets("local", "/api/tasks/t1/"))
  await waitFor(() => expect(view.result.current.failed).toBe(true))
  expect(view.result.current.src).toBeNull()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original)
})

it("leaves what a refresh skips untouched", async () => {
  const fetchAsset = vi.fn().mockResolvedValue(new Blob(["bytes"]))
  const view = renderHook(() => useAssetSrc(PATH), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(view.result.current).toMatch(/^blob:/))
  act(() => refreshAssets("local", "", (path) => path === PATH))
  expect(fetchAsset).toHaveBeenCalledTimes(1)
})

/**
 * A content-addressed output is skipped by a reconnect's refresh because its
 * bytes cannot have changed. One that failed has no bytes to keep: a fetch
 * that met a daemon going down must be asked again once it is back.
 */
it("asks again for a skipped path whose fetch failed", async () => {
  const OUTPUT = "/api/tasks/t1/outputs/1/abc123"
  const fetchAsset = vi.fn().mockRejectedValueOnce(new Error("Could not reach the daemon"))
    .mockResolvedValue(new Blob(["bytes"]))
  const view = renderHook(() => useAssetStatus(OUTPUT), { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
  await waitFor(() => expect(view.result.current.failed).toBe(true))

  act(() => refreshAssets("local", "", (path) => path === OUTPUT))
  await waitFor(() => expect(view.result.current.src).toMatch(/^blob:/))
  expect(view.result.current.failed).toBe(false)
  expect(fetchAsset).toHaveBeenCalledTimes(2)
})

describe("a lazy image", () => {
  /** A hand-driven IntersectionObserver: `move` brings one target into range or out of it. */
  let targets: Map<Element, IntersectionObserverCallback>
  beforeEach(() => {
    targets = new Map()
    vi.stubGlobal("IntersectionObserver", class {
      readonly callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) { this.callback = callback }
      observe(target: Element) { targets.set(target, this.callback) }
      unobserve(target: Element) { targets.delete(target) }
      disconnect() {}
    })
  })
  const move = (target: Element, isIntersecting: boolean) =>
    act(() => targets.get(target)?.([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver))

  function lazyImage(path: string, fetchAsset: DaemonTransport["fetchAsset"]) {
    const view = { result: { current: null as unknown as AssetStatus } }
    function Probe() {
      const status = useAssetStatus(path, { lazy: true })
      view.result.current = status
      return <img ref={status.ref} src={status.src ?? undefined} alt="" />
    }
    const { container } = render(<Probe />, { wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })) })
    return { element: container.querySelector("img")!, view }
  }

  it("fetches only once it is near the viewport", async () => {
    const fetchAsset = vi.fn().mockResolvedValue(new Blob(["bytes"]))
    const { element, view } = lazyImage(PATH, fetchAsset)
    await waitFor(() => expect(targets.has(element)).toBe(true))
    expect(fetchAsset).not.toHaveBeenCalled()
    expect(view.result.current.src).toBeNull()

    move(element, true)
    await waitFor(() => expect(view.result.current.src).toMatch(/^blob:/))
    expect(fetchAsset).toHaveBeenCalledTimes(1)
  })

  /** Mounted history no longer pins its bytes: only what is near the viewport is held. */
  it("lets eviction release it once it is far off screen, and fetches it again on the way back", async () => {
    const fetchAsset = vi.fn().mockImplementation(() => Promise.resolve(new Blob(["bytes"])))
    const { element, view } = lazyImage("/api/tasks/t1/attachments/1/far.png", fetchAsset)
    await waitFor(() => expect(targets.has(element)).toBe(true))
    move(element, true)
    await waitFor(() => expect(view.result.current.src).toMatch(/^blob:/))
    const far = view.result.current.src
    move(element, false)

    for (let index = 0; index < 40; index++) {
      const passing = renderHook(() => useAssetSrc(`/api/tasks/t1/attachments/1/passing-${index}.png`), {
        wrapper: runtimeWrapper(fakeDaemonTransport("local", { fetchAsset })),
      })
      await waitFor(() => expect(passing.result.current).toMatch(/^blob:/))
      passing.unmount()
    }

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(far)
    expect(view.result.current.src).toBeNull()
    move(element, true)
    await waitFor(() => expect(view.result.current.src).toMatch(/^blob:/))
  })
})
