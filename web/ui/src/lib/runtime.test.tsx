import { QueryClient } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { useEffect, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import {
  createDaemonRuntime,
  DaemonRuntimeProvider,
  useDaemonRuntime,
} from "./runtime"
import type { DaemonTransport } from "./transport"

function fakeTransport(connectionId: string): DaemonTransport {
  return {
    connectionId,
    request: <T,>() => Promise.resolve({} as T),
    openEventStream: () => ({}) as EventSource,
    openWebSocket: () => ({}) as WebSocket,
    assetUrl: (path) => path,
    ensureReady: () => Promise.resolve(),
  }
}

describe("connection runtimes", () => {
  it("keeps duplicate daemon task IDs in distinct query-cache records", () => {
    const first = createDaemonRuntime(fakeTransport("connection-one"))
    const second = createDaemonRuntime(fakeTransport("connection-two"))
    const firstKey = first.qk.task("duplicate-task")
    const secondKey = second.qk.task("duplicate-task")
    const client = new QueryClient()

    client.setQueryData(firstKey, { title: "First daemon" })
    client.setQueryData(secondKey, { title: "Second daemon" })

    expect(firstKey).toEqual(["connection-one", "task", "duplicate-task"])
    expect(secondKey).toEqual(["connection-two", "task", "duplicate-task"])
    expect(client.getQueryData(firstKey)).toEqual({ title: "First daemon" })
    expect(client.getQueryData(secondKey)).toEqual({ title: "Second daemon" })
  })

  it("provides one frozen runtime with keys pre-bound to its transport", () => {
    const transport = fakeTransport("connection-one")
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DaemonRuntimeProvider transport={transport}>
        {children}
      </DaemonRuntimeProvider>
    )
    const { result, rerender } = renderHook(useDaemonRuntime, { wrapper })
    const initial = result.current

    rerender()

    expect(result.current).toBe(initial)
    expect(result.current.connectionId).toBe("connection-one")
    expect(result.current.qk.tasks).toEqual(["connection-one", "tasks"])
    expect(Object.isFrozen(result.current)).toBe(true)
    expect(Object.isFrozen(result.current.qk)).toBe(true)
  })

  it("keeps the runtime stable when an inline recovery policy changes", async () => {
    const transport = fakeTransport("connection-one")
    const firstRecovery = vi.fn()
    const secondRecovery = vi.fn()
    let recovery = firstRecovery
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DaemonRuntimeProvider
        transport={transport}
        recoverAfterUpdate={() => recovery()}
      >
        {children}
      </DaemonRuntimeProvider>
    )
    const { result, rerender } = renderHook(useDaemonRuntime, { wrapper })
    const initial = result.current

    recovery = secondRecovery
    rerender()
    await act(async () => result.current.recoverAfterUpdate())

    expect(result.current).toBe(initial)
    expect(firstRecovery).not.toHaveBeenCalled()
    expect(secondRecovery).toHaveBeenCalledTimes(1)
  })

  it("remounts every consumer when the immutable connection changes", () => {
    const lifecycle: string[] = []
    const first = fakeTransport("connection-one")
    const second = fakeTransport("connection-two")
    let transport = first

    function useLifecycle() {
      const runtime = useDaemonRuntime()
      useEffect(() => {
        lifecycle.push(`mount:${runtime.connectionId}`)
        return () => {
          lifecycle.push(`unmount:${runtime.connectionId}`)
        }
      }, [runtime])
      return runtime.connectionId
    }

    const wrapper = ({ children }: { children: ReactNode }) => (
      <DaemonRuntimeProvider transport={transport}>
        {children}
      </DaemonRuntimeProvider>
    )
    const { result, rerender } = renderHook(useLifecycle, { wrapper })
    expect(result.current).toBe("connection-one")

    transport = second
    rerender()

    expect(result.current).toBe("connection-two")
    expect(lifecycle).toEqual([
      "mount:connection-one",
      "unmount:connection-one",
      "mount:connection-two",
    ])
  })
})
