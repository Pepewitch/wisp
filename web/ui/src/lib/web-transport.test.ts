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

  it("mints the EventSource cookie from the saved browser token", async () => {
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

  it("accepts an existing cookie after a headerless same-origin probe", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }))

    await sameOriginWebTransport.ensureReady()

    expect(fetchMock).toHaveBeenCalledWith("/api/outbox")
  })

  it("keeps stream and asset paths same-origin and derives the websocket scheme", () => {
    const eventUrls: string[] = []
    const socketUrls: string[] = []
    class FakeEventSource {
      constructor(url: string | URL) {
        eventUrls.push(String(url))
      }
    }
    class FakeWebSocket {
      constructor(url: string | URL) {
        socketUrls.push(String(url))
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("WebSocket", FakeWebSocket)

    sameOriginWebTransport.openEventStream("/api/events")
    sameOriginWebTransport.openWebSocket(
      "/api/tasks/duplicate-task/terminal?shell=2"
    )

    expect(sameOriginWebTransport.connectionId).toBe("local")
    expect(
      sameOriginWebTransport.assetUrl(
        "/api/tasks/duplicate-task/attachments/1/image.png"
      )
    ).toBe("/api/tasks/duplicate-task/attachments/1/image.png")
    expect(eventUrls).toEqual(["/api/events"])
    expect(socketUrls).toEqual([
      "ws://localhost:3000/api/tasks/duplicate-task/terminal?shell=2",
    ])
    expect(Object.isFrozen(sameOriginWebTransport)).toBe(true)
  })
})
