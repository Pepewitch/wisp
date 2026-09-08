import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  authStore,
  completeAuth,
  sameOriginWebTransport,
} from "./web-transport"

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe("the same-origin web transport", () => {
  it("preserves bearer fallback, relative requests, and JSON writes", async () => {
    localStorage.setItem("wisp_token", "synthetic-browser-token")
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ saved: true }))

    await expect(
      sameOriginWebTransport.request("/api/tasks/duplicate-task", {
        method: "POST",
        body: { title: "Updated" },
      })
    ).resolves.toEqual({ saved: true })

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/duplicate-task", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-browser-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Updated" }),
      signal: undefined,
    })
  })

  it("parks a 401 once and retries with the replacement token", async () => {
    localStorage.setItem("wisp_token", "stale-synthetic-token")
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    const pending = sameOriginWebTransport.request<{ ok: boolean }>(
      "/api/status"
    )
    await vi.waitFor(() => expect(authStore.snapshot().open).toBe(true))
    completeAuth("fresh-synthetic-token")

    await expect(pending).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: "Bearer fresh-synthetic-token",
    })
  })

  it("verifies the saved token instead of minting an ambient session", async () => {
    localStorage.setItem("wisp_token", "synthetic-browser-token")
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }))

    await sameOriginWebTransport.ensureReady()

    expect(fetchMock).toHaveBeenCalledWith("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "synthetic-browser-token" }),
    })
  })

  /**
   * SEC-01. There used to be a headerless probe here, because the daemon's
   * HttpOnly cookie could outlive localStorage and prove that streams and
   * media were already authenticated. No such credential exists now, so a
   * browser without a stored token has nothing to fall back on and must ask.
   */
  it("asks for a token rather than probing for an ambient credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")

    const pending = sameOriginWebTransport.ensureReady()
    await vi.waitFor(() => expect(authStore.snapshot().open).toBe(true))
    completeAuth("fresh-synthetic-token")
    await pending

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("streams events over an authenticated fetch, never an EventSource", () => {
    localStorage.setItem("wisp_token", "synthetic-browser-token")
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }))
    class ForbiddenEventSource {
      constructor() {
        throw new Error("the browser runtime must not use EventSource")
      }
    }
    vi.stubGlobal("EventSource", ForbiddenEventSource)

    const stream = sameOriginWebTransport.openEventStream("/api/events")
    stream.close()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/events")
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer synthetic-browser-token",
    })
  })

  it("fetches media with the bearer header", async () => {
    localStorage.setItem("wisp_token", "synthetic-browser-token")
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("bytes", { status: 200 }))

    const path = "/api/tasks/duplicate-task/attachments/1/image.png"
    // Asserted by CONTENT, not by `instanceof Blob`: jsdom and Node each bring
    // their own Blob class, so identity depends on which one the environment
    // installed. This passed locally and failed on CI for exactly that reason.
    const blob = await sameOriginWebTransport.fetchAsset!(path)
    expect(await blob.text()).toBe("bytes")

    expect(fetchMock).toHaveBeenCalledWith(path, {
      headers: { authorization: "Bearer synthetic-browser-token" },
      cache: "no-store",
    })
  })

  it("hands the terminal socket a credential to send in-band", () => {
    localStorage.setItem("wisp_token", "synthetic-browser-token")
    expect(sameOriginWebTransport.socketToken!()).toBe("synthetic-browser-token")
    localStorage.clear()
    expect(sameOriginWebTransport.socketToken!()).toBeNull()
  })

  it("keeps asset paths same-origin and derives the websocket scheme", () => {
    const socketUrls: string[] = []
    class FakeWebSocket {
      constructor(url: string | URL) {
        socketUrls.push(String(url))
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket)

    sameOriginWebTransport.openWebSocket(
      "/api/tasks/duplicate-task/terminal?shell=2"
    )

    expect(sameOriginWebTransport.connectionId).toBe("local")
    expect(
      sameOriginWebTransport.assetUrl(
        "/api/tasks/duplicate-task/attachments/1/image.png"
      )
    ).toBe("/api/tasks/duplicate-task/attachments/1/image.png")
    expect(socketUrls).toEqual([
      "ws://localhost:3000/api/tasks/duplicate-task/terminal?shell=2",
    ])
    expect(Object.isFrozen(sameOriginWebTransport)).toBe(true)
  })
})
