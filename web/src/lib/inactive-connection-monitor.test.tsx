import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopConnectionEntry } from "./desktop-connections"
import { InactiveConnectionMonitor } from "./inactive-connection-monitor"
import type { DaemonEventStream, DaemonTransport } from "./transport"
import type { ApiTask } from "./types"
import { fakeDaemonTransport } from "@/test/runtime"

class FakeEvents implements DaemonEventStream {
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  close = vi.fn()
  addEventListener() {}
  open() { this.onopen?.() }
  error() { this.onerror?.() }
  message(type: string) { this.onmessage?.({ data: JSON.stringify({ type, taskId: "task-a" }) }) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const task = (id: string) => ({ id, archived: false, state: "done" }) as ApiTask

function fixture(request: ReturnType<typeof vi.fn>) {
  const events = new FakeEvents()
  const entry: DesktopConnectionEntry = {
    metadata: {
      id: "inactive-remote", kind: "remote", name: "Remote", url: "https://example.test",
      instanceId: "instance-a", ready: true,
    },
    transport: fakeDaemonTransport("inactive-remote", {
      request: request as DaemonTransport["request"],
      openEventStream: () => events,
    }),
  }
  const onAttention = vi.fn()
  const onReachability = vi.fn()
  const onTasks = vi.fn()
  const view = render(<InactiveConnectionMonitor
    entry={entry} onAttention={onAttention} onReachability={onReachability} onTasks={onTasks}
  />)
  return { events, onAttention, onReachability, onTasks, view }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("inactive connection task refresh", () => {
  it("serializes the first-open reconciliation behind an in-flight initial read", async () => {
    const first = deferred<ApiTask[]>()
    const second = deferred<ApiTask[]>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { events, onTasks, view } = fixture(request)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]).toEqual({ signal: expect.any(AbortSignal) })
    act(() => events.open())
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve([task("initial")]))
    expect(onTasks).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve([task("reconciled")]))
    expect(onTasks).toHaveBeenCalledOnce()
    expect(onTasks.mock.calls[0]?.[1]).toEqual([task("reconciled")])
    view.unmount()
  })

  it("rechecks when a task changes after the first snapshot but before SSE opens", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce([task("old-state")])
      .mockResolvedValueOnce([task("new-state")])
    const { events, onTasks, view } = fixture(request)
    await act(async () => Promise.resolve())
    expect(onTasks.mock.calls[0]?.[1]).toEqual([task("old-state")])
    act(() => {
      events.open()
      vi.advanceTimersByTime(0)
    })
    await act(async () => Promise.resolve())
    expect(request).toHaveBeenCalledTimes(2)
    expect(onTasks.mock.calls[1]?.[1]).toEqual([task("new-state")])
    view.unmount()
  })

  it("discards a stale response and makes one trailing read for task and workflow events", async () => {
    const first = deferred<ApiTask[]>()
    const second = deferred<ApiTask[]>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { events, onTasks, view } = fixture(request)
    act(() => {
      events.open()
      events.message("task")
      events.message("workflow")
      events.message("project") // does not invalidate the task list
      vi.advanceTimersByTime(250)
    })
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve([task("stale")]))
    expect(onTasks).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve([task("fresh")]))
    expect(onTasks).toHaveBeenCalledOnce()
    expect(onTasks.mock.calls[0]?.[1]).toEqual([task("fresh")])
    view.unmount()
  })

  it("ignores unrelated events and refreshes after a disconnect and reopen", async () => {
    const request = vi.fn().mockResolvedValue([task("task-a")])
    const { events, view } = fixture(request)
    await act(async () => Promise.resolve())
    act(() => {
      events.open()
      vi.advanceTimersByTime(0)
    })
    await act(async () => Promise.resolve())
    act(() => {
      for (const type of ["project", "settings", "harnesses", "harness-limits", "message", "terminals"])
        events.message(type)
      vi.advanceTimersByTime(250)
    })
    expect(request).toHaveBeenCalledTimes(2)
    act(() => {
      events.error()
      events.open()
      vi.advanceTimersByTime(0)
    })
    expect(request).toHaveBeenCalledTimes(3)
    view.unmount()
  })

  it("retries an initial failure after first open and aborts a read on disposal", async () => {
    const pending = deferred<ApiTask[]>()
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise)
    const { events, onTasks, view } = fixture(request)
    await act(async () => Promise.resolve())
    act(() => {
      events.open()
      vi.advanceTimersByTime(0)
    })
    expect(request).toHaveBeenCalledTimes(2)
    const signal = request.mock.calls[1]?.[1]?.signal as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve([task("late")]))
    expect(onTasks).not.toHaveBeenCalled()
  })

  it("retries when the first read fails after the stream has opened", async () => {
    const first = deferred<ApiTask[]>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce([task("recovered")])
    const { events, onTasks, view } = fixture(request)
    act(() => events.open())
    await act(async () => first.reject(new Error("offline")))
    act(() => vi.advanceTimersByTime(0))
    await act(async () => Promise.resolve())
    expect(request).toHaveBeenCalledTimes(2)
    expect(onTasks.mock.calls[0]?.[1]).toEqual([task("recovered")])
    view.unmount()
  })
})
