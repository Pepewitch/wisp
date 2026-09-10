import { describe, expect, it, vi } from "vitest"

import { openFetchEventStream } from "./fetch-event-source"

/** A stream whose chunks are pushed by the test, so framing can be split anywhere. */
function pushable(): {
  body: ReadableStream<Uint8Array>
  push: (text: string) => void
  end: () => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    body,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  }
}

function eventStreamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the fetch-based event stream", () => {
  it("replaces suspended streams on foregrounding without an old stream scheduling another retry", async () => {
    const first = pushable()
    const second = pushable()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(eventStreamResponse(first.body))
      .mockResolvedValueOnce(eventStreamResponse(second.body))
    const source = openFetchEventStream("/api/events", { fetchImpl, retryMs: 1 })
    const messages: string[] = []
    source.onmessage = (event) => messages.push(event.data)
    await settle()
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]![1].signal.aborted).toBe(true)
    first.push("data: stale\n\n")
    second.push("data: current\n\n")
    await settle()
    await settle()
    expect(messages).toEqual(["current"])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    source.close()
    window.dispatchEvent(new Event("online"))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("does not revive a refused stream when the device comes online", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }))
    const source = openFetchEventStream("/api/events", { fetchImpl })
    await settle()
    window.dispatchEvent(new Event("online"))
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(source.readyState).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    source.close()
  })

  it("carries the authorization header the browser cannot put on an EventSource", async () => {
    const stream = pushable()
    const fetchImpl = vi.fn().mockResolvedValue(eventStreamResponse(stream.body))

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: () => ({ authorization: "Bearer synthetic" }),
    })
    await settle()

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer synthetic",
    })
    source.close()
  })

  it("dispatches default and named frames, joins multi-line data, and ignores heartbeats", async () => {
    const stream = pushable()
    const fetchImpl = vi.fn().mockResolvedValue(eventStreamResponse(stream.body))
    const messages: string[] = []
    const backlog: string[] = []
    let opens = 0

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    source.onmessage = (event) => messages.push(event.data)
    source.onopen = () => opens++
    source.addEventListener("backlog", (event) => backlog.push(event.data))
    await settle()

    expect(opens).toBe(1)
    expect(source.readyState).toBe(1)

    stream.push('data: {"type":"task"}\n\n')
    stream.push(": heartbeat\n\n")
    stream.push("event: backlog\ndata: first\ndata: second\n\n")
    // a frame split across chunks must still arrive exactly once
    stream.push('data: {"type":"tu')
    await settle()
    expect(messages).toEqual(['{"type":"task"}'])
    stream.push('rn"}\n\n')
    await settle()

    expect(messages).toEqual(['{"type":"task"}', '{"type":"turn"}'])
    expect(backlog).toEqual(["first\nsecond"])
    source.close()
  })

  it("reconnects after the daemon drops the stream", async () => {
    const first = pushable()
    const second = pushable()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(eventStreamResponse(first.body))
      .mockResolvedValueOnce(eventStreamResponse(second.body))
    let opens = 0
    let errors = 0

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 1,
    })
    source.onopen = () => opens++
    source.onerror = () => errors++
    await settle()
    expect(opens).toBe(1)

    first.end()
    await settle()
    expect(errors).toBe(1)
    // A drop is recoverable, so the stream must NOT look permanently closed —
    // the events bridge would otherwise start its own rebuild on top of this one.
    expect(source.readyState).toBe(0)

    await vi.waitFor(() => expect(opens).toBe(2))
    source.close()
  })

  it("reports a refusal as CLOSED and never retries it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }))
    let closedInHandler: number | null = null

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 1,
    })
    source.onerror = () => {
      closedInHandler = source.readyState
    }
    await vi.waitFor(() => expect(closedInHandler).not.toBeNull())

    // The handler has to see CLOSED, because that is what tells it to
    // re-authenticate and rebuild rather than wait.
    expect(closedInHandler).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    source.close()
  })

  it("retries a transient server failure", async () => {
    const stream = pushable()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(eventStreamResponse(stream.body))
    let opens = 0

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 1,
    })
    source.onopen = () => opens++

    await vi.waitFor(() => expect(opens).toBe(1))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    source.close()
  })

  it("close() aborts the request and stops delivering", async () => {
    const stream = pushable()
    const fetchImpl = vi.fn().mockResolvedValue(eventStreamResponse(stream.body))
    const messages: string[] = []

    const source = openFetchEventStream("/api/events", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 1,
    })
    source.onmessage = (event) => messages.push(event.data)
    await settle()

    source.close()
    expect(source.readyState).toBe(2)
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(signal.aborted).toBe(true)

    stream.push("data: after-close\n\n")
    await settle()
    expect(messages).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
