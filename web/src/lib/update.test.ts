import { describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport } from "@/test/runtime"
import type { DaemonRequestOptions, DaemonTransport } from "./transport"
import type { UpdateStatus } from "./types"
import { daemonCanInstall, daemonRestartsAutomatically, waitForUpdatedDaemon } from "./update"

describe("waitForUpdatedDaemon", () => {
  it("waits across the restart gap for the requested health version", async () => {
    let healthCalls = 0
    const request = vi.fn(async (path: string) => {
      if (path === "/api/health") {
        healthCalls++
        if (healthCalls === 1) return { ok: true, version: "0.4.0-alpha.6" }
        if (healthCalls === 2) throw new TypeError("connection refused")
        return { ok: true, version: "0.4.0-alpha.8" }
      }
      return {
        currentVersion: "0.4.0-alpha.6",
        latestVersion: "0.4.0-alpha.8",
        state: "restarting",
      }
    })
    const transport = fakeDaemonTransport("connection-one", {
      request: request as DaemonTransport["request"],
    })

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.8", { transport, timeoutMs: 100, pollMs: 0 }),
    ).resolves.toEqual({ kind: "restarted" })
    expect(healthCalls).toBe(3)
  })

  it("surfaces a failed installation reported by the old daemon", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/api/health"
        ? { ok: true, version: "0.4.0-alpha.6" }
        : { state: "failed", message: "update failed: checksum mismatch" },
    )
    const transport = fakeDaemonTransport("connection-one", {
      request: request as DaemonTransport["request"],
    })

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.8", { transport, timeoutMs: 100, pollMs: 0 }),
    ).rejects.toThrow("update failed: checksum mismatch")
  })

  it("stops waiting when the daemon installed an update nothing will restart it for", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/api/health"
        ? { ok: true, version: "0.4.0-alpha.6" }
        : { state: "restart-required", message: "Wisp 0.4.0-alpha.8 is installed. Restart the daemon." },
    )
    const transport = fakeDaemonTransport("connection-one", {
      request: request as DaemonTransport["request"],
    })

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.8", { transport, timeoutMs: 100, pollMs: 0 }),
    ).resolves.toEqual({
      kind: "restart-required",
      message: "Wisp 0.4.0-alpha.8 is installed. Restart the daemon.",
    })
  })

  it("bounds a health request by the overall restart deadline", async () => {
    const request = vi.fn(
      async (_path: string, options?: DaemonRequestOptions) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }),
    )
    const transport = fakeDaemonTransport("connection-one", {
      request: request as DaemonTransport["request"],
    })

    await expect(
      waitForUpdatedDaemon("0.4.0-alpha.8", { transport, timeoutMs: 10, pollMs: 0 }),
    ).rejects.toThrow("did not start within 0 seconds")
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe("reading what a daemon can do", () => {
  const base = { canAutoUpdate: false } as UpdateStatus

  it("falls back to canAutoUpdate for a daemon from before canInstall", () => {
    expect(daemonCanInstall(base)).toBe(false)
    expect(daemonCanInstall({ ...base, canAutoUpdate: true })).toBe(true)
    expect(daemonRestartsAutomatically(base)).toBe(true)
  })

  it("reads both fields from a current daemon", () => {
    const unsupervised = { ...base, canInstall: true, restartsAutomatically: false }
    expect(daemonCanInstall(unsupervised)).toBe(true)
    expect(daemonRestartsAutomatically(unsupervised)).toBe(false)
    expect(daemonCanInstall({ ...base, canAutoUpdate: true, canInstall: false })).toBe(false)
  })
})
