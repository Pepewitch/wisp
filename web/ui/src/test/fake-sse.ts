import type { SseLike } from "@/lib/sse"

/** Hand-driven EventSource used by stream consumers in unit tests. */
export function createFakeSse() {
  const listeners = new Map<string, ((event: { data: string }) => void)[]>()
  let closed = false
  let readyState = 1
  const source: SseLike = {
    onmessage: null,
    onopen: null,
    onerror: null,
    get readyState() {
      return readyState
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    close() {
      closed = true
    },
  }
  return {
    source,
    isClosed: () => closed,
    fail() {
      readyState = 2
      source.onerror?.()
    },
    emit(type: string, data: unknown) {
      for (const listener of listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
    },
  }
}
