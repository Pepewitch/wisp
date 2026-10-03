import { afterEach, describe, expect, it, vi } from "vitest"

import { readTextPrefix } from "./attachment-text"

/** A transfer that keeps going after `chunks`, the way a 20 MB file would. */
function streamOf(chunks: Uint8Array[]) {
  const cancel = vi.fn()
  const queue = [...chunks]
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(queue.shift() ?? new Uint8Array(1024))
    },
    cancel,
  })
  return { body, cancel }
}

describe("readTextPrefix", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads a file shorter than the cap whole", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a,b\n1,2\n")))
    await expect(readTextPrefix("/x", 1024)).resolves.toEqual({ text: "a,b\n1,2\n", truncated: false })
  })

  it("stops at the cap, cancels the transfer, and never splits a character", async () => {
    const enc = new TextEncoder()
    // "é" is two bytes; a cap of 4 lands between them
    const { body, cancel } = streamOf([enc.encode("abc"), enc.encode("é and more")])
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)))
    await expect(readTextPrefix("/x", 4)).resolves.toEqual({ text: "abc", truncated: true })
    expect(cancel).toHaveBeenCalled()
  })

  it("fails on a refused read rather than rendering the error body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 410 })))
    await expect(readTextPrefix("/x", 1024)).rejects.toThrow("410")
  })
})
