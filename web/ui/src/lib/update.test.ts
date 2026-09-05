import { describe, expect, it, vi } from "vitest"

import { waitForUpdatedDaemon } from "./update"

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}

describe("waitForUpdatedDaemon", () => {
  it("waits across the restart gap for the requested health version", async () => {
    let healthCalls = 0
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/health") {
        healthCalls++
        if (healthCalls === 1) return jsonResponse({ ok: true, version: "0.4.0-alpha.6" })
        if (healthCalls === 2) throw new TypeError("connection refused")
        return jsonResponse({ ok: true, version: "0.4.0-alpha.7" })
      }
      return jsonResponse({
        currentVersion: "0.4.0-alpha.6",
        latestVersion: "0.4.0-alpha.7",
        state: "restarting",
      })
    })

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.7", { request: request as typeof fetch, timeoutMs: 100, pollMs: 0 }),
    ).resolves.toBeUndefined()
    expect(healthCalls).toBe(3)
  })

  it("surfaces a failed installation reported by the old daemon", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/health"
        ? jsonResponse({ ok: true, version: "0.4.0-alpha.6" })
        : jsonResponse({ state: "failed", message: "update failed: checksum mismatch" }),
    )

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.7", { request: request as typeof fetch, timeoutMs: 100, pollMs: 0 }),
    ).rejects.toThrow("update failed: checksum mismatch")
  })

  it("bounds a health request by the overall restart deadline", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }),
    )

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.7", { request: request as typeof fetch, timeoutMs: 10, pollMs: 0 }),
    ).rejects.toThrow("did not start within 0 seconds")
    expect(request).toHaveBeenCalledTimes(1)
  })
})
