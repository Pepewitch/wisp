import { afterEach, describe, expect, it, vi } from "vitest"

import { createDesktopTransport } from "./desktop-transport"

afterEach(() => vi.unstubAllGlobals())

describe("desktop daemon transport", () => {
  it("permanently qualifies JSON, SSE, WebSocket and media under its connection id", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }))
    )
    const eventUrls: string[] = []
    const socketUrls: string[] = []
    class EventSourceStub {
      constructor(url: string | URL) {
        eventUrls.push(String(url))
      }
    }
    class WebSocketStub {
      constructor(url: string | URL) {
        socketUrls.push(String(url))
      }
    }
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", EventSourceStub)
    vi.stubGlobal("WebSocket", WebSocketStub)

    const transport = createDesktopTransport(
      "http://127.0.0.1:45123/per-launch-capability/",
      "remote-one"
    )
    await transport.request("/api/tasks?archived=1", {
      method: "POST",
      body: { value: 1 },
    })
    transport.openEventStream("/api/events")
    transport.openWebSocket("/api/tasks/synthetic/terminal?shell=0")

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:45123/per-launch-capability/connections/remote-one/api/tasks?archived=1",
      expect.objectContaining({
        method: "POST",
        body: '{"value":1}',
        headers: { "content-type": "application/json" },
        credentials: "omit",
        redirect: "error",
      })
    )
    expect(eventUrls).toEqual([
      "http://127.0.0.1:45123/per-launch-capability/connections/remote-one/api/events",
    ])
    expect(socketUrls).toEqual([
      "ws://127.0.0.1:45123/per-launch-capability/connections/remote-one/api/tasks/synthetic/terminal?shell=0",
    ])
    expect(
      transport.assetUrl("/api/tasks/synthetic/attachments/1/image.png")
    ).toBe(
      "http://127.0.0.1:45123/per-launch-capability/connections/remote-one/api/tasks/synthetic/attachments/1/image.png"
    )
    expect(Object.isFrozen(transport)).toBe(true)
    expect(JSON.stringify(transport)).not.toContain("token")
  })

  it("preserves upstream errors and never accepts an unqualified or absolute path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "synthetic refusal" }), {
            status: 409,
            headers: { "x-wisp-proxy-error": "identity-changed" },
          })
      )
    )
    const transport = createDesktopTransport(
      "http://127.0.0.1:45123/per-launch-capability",
      "local"
    )

    await expect(
      transport.request("/api/tasks/synthetic/archive", { method: "POST" })
    ).rejects.toEqual(
      expect.objectContaining({
        message: "synthetic refusal",
        status: 409,
        code: "identity-changed",
      })
    )
    expect(() =>
      transport.assetUrl("https://other.example.test/api/tasks")
    ).toThrow("must begin with /api")
    expect(() => transport.assetUrl("/apiary/not-an-api-route")).toThrow(
      "must begin with /api"
    )
  })
})
