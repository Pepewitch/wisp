import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"
import { ApiError, type DaemonTransport } from "@/lib/transport"
import type { ShellInfo } from "@/lib/types"

import { useShellTabs } from "./useShellTabs"

function shell(id: number, number: number, extra: Partial<ShellInfo> = {}): ShellInfo {
  return {
    id,
    number,
    name: null,
    title: null,
    program: null,
    shell: "zsh",
    exitCode: null,
    createdAt: "2026-09-04T12:00:00Z",
    ...extra,
  }
}

type Route = (path: string, init?: { method?: string; body?: unknown }) => unknown

function harness(route: Route, features: Record<string, boolean> | Error = { taskTerminals: true }) {
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/api/harnesses") {
      if (features instanceof Error) throw features
      return { harnesses: [], features }
    }
    return route(path, init)
  })
  const transport = fakeDaemonTransport("local", { request: request as unknown as DaemonTransport["request"] })
  const reconnect = vi.fn()
  const view = renderHook(() => useShellTabs({ taskId: "tshell", available: true, reconnect }), {
    wrapper: runtimeWrapper(transport),
  })
  return { request, reconnect, view }
}

const calls = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls
    .filter(([path]) => path !== "/api/harnesses")
    .map(([path, init]) => `${(init as { method?: string } | undefined)?.method ?? "GET"} ${path}`)

describe("useShellTabs", () => {
  beforeEach(() => localStorage.clear())

  it("shows the daemon's tabs, named after what they run", async () => {
    const { view } = harness(() => [shell(0, 1), shell(3, 4, { program: "vim" }), shell(1, 5)])
    await waitFor(() => expect(view.result.current.shells).toEqual([0, 3, 1]))
    expect([0, 3, 1].map(view.result.current.labelOf)).toEqual(["zsh", "vim", "zsh 2"])
  })

  it("opens a tab when the task has none", async () => {
    const { request, view } = harness((_path, init) => (init?.method === "POST" ? shell(0, 1) : []))
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    // ifEmpty: a second window opening the same task at once gets this tab, not another
    expect(calls(request)).toEqual(["GET /api/tasks/tshell/terminals", "POST /api/tasks/tshell/terminals?ifEmpty=1"])
  })

  it("says so when the tab list cannot be read, rather than showing no shells", async () => {
    const { request, view } = harness(() => {
      throw new ApiError("daemon hiccup", 500)
    })
    await waitFor(() => expect(view.result.current.failure).toBe("Could not load this task's shells: daemon hiccup"))
    expect(view.result.current.shells).toEqual([])
    expect(view.result.current.canOpen).toBe(false)
    await act(() => view.result.current.openTab())
    expect(calls(request).some((call) => call.startsWith("POST"))).toBe(false)
  })

  it("waits out a failed feature check instead of falling back to per-browser tabs", async () => {
    const { request, view } = harness(() => [shell(0, 1)], new ApiError("daemon hiccup", 500))
    await waitFor(() => expect(view.result.current.failure).toBe("Could not load this task's shells: daemon hiccup"))
    expect(view.result.current.shells).toEqual([])
    expect(view.result.current.canOpen).toBe(false)
    expect(calls(request)).toEqual([])
  })

  it("treats a daemon with no harness route as one without the tab list", async () => {
    const { view } = harness(() => [], new ApiError("not found", 404))
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    expect(view.result.current.daemonTabs).toBe(false)
    expect(view.result.current.failure).toBeNull()
  })

  it("asks before closing a busy shell, then closes it with force", async () => {
    let listed = [shell(0, 1), shell(1, 2)]
    const { request, view } = harness((path, init) => {
      if (init?.method !== "DELETE") return listed
      if (!path.endsWith("?force=1")) throw new ApiError("bun is still running in this shell", 409)
      listed = [shell(0, 1)]
      return { ok: true }
    })
    await waitFor(() => expect(view.result.current.shells).toEqual([0, 1]))
    act(() => view.result.current.activate(1))

    await act(() => view.result.current.closeTab(1))
    expect(view.result.current.pendingKill).toEqual({
      kind: "close",
      id: 1,
      label: "zsh 2",
      reason: "bun is still running in this shell",
    })
    expect(view.result.current.shells).toEqual([0, 1])

    act(() => view.result.current.confirmKill())
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    expect(view.result.current.activeId).toBe(0)
    expect(view.result.current.pendingKill).toBeNull()
    expect(calls(request)).toContain("DELETE /api/tasks/tshell/terminals/1?force=1")
  })

  it("never closes the last tab", async () => {
    const { request, view } = harness(() => [shell(0, 1)])
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    await act(() => view.result.current.closeTab(0))
    expect(calls(request).some((call) => call.startsWith("DELETE"))).toBe(false)
  })

  it("restarts a tab in place and reattaches its view", async () => {
    const { reconnect, view } = harness((path, init) =>
      init?.method === "POST" && path.endsWith("/restart") ? shell(0, 1) : [shell(0, 1, { exitCode: 1 })],
    )
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    await act(() => view.result.current.restartTab(0))
    expect(reconnect).toHaveBeenCalledWith(0)
    expect(view.result.current.infoOf(0)?.exitCode).toBeNull()
  })

  it("renames optimistically and rolls back a refusal", async () => {
    const { view } = harness((_path, init) => {
      if (init?.method === "PATCH") throw new ApiError("no such shell", 404)
      return [shell(0, 1)]
    })
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    await act(() => view.result.current.renameTab(0, "  server  "))
    expect(view.result.current.labelOf(0)).toBe("zsh")
    expect(view.result.current.failure).toBe("no such shell")
  })

  it("keeps the per-browser tabs on a daemon without the tab list", async () => {
    const { request, view } = harness(() => {
      throw new Error("an old daemon has no terminals route")
    }, {})
    await waitFor(() => expect(view.result.current.shells).toEqual([0]))
    await act(() => view.result.current.openTab())
    expect(view.result.current.shells).toEqual([0, 1])
    expect(view.result.current.labelOf(1)).toBe("Shell 2")
    await act(() => view.result.current.closeTab(0))
    // the smallest free id is reused, which reattaches to its running shell
    await act(() => view.result.current.openTab())
    expect(view.result.current.shells).toEqual([1, 0])
    expect(calls(request)).toEqual([])
  })
})
