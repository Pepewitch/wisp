import { useEffect } from "react"

import { connectionAttention, type ConnectionAttention } from "@/lib/connection-attention"
import { classifyConnectionError, type ConnectionReachability } from "@/lib/connection-reachability"
import { connectionStore } from "@/lib/conn"
import type { DesktopConnectionEntry } from "@/lib/desktop-connections"
import type { DaemonEventStream } from "@/lib/transport"
import type { ApiTask } from "@/lib/types"

/** Unknown event types stay refreshable so a newer daemon can add task facts. */
function canChangeTaskList(data: string): boolean {
  try {
    const event: unknown = JSON.parse(data)
    if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") return true
    return !["project", "settings", "harnesses", "harness-limits", "message", "terminals"].includes(event.type)
  } catch {
    return true
  }
}

export function InactiveConnectionMonitor({
  entry,
  onAttention,
  onReachability,
  onTasks,
}: {
  entry: DesktopConnectionEntry
  onAttention: (connectionId: string, attention: ConnectionAttention) => void
  onReachability: (connectionId: string, value: ConnectionReachability) => void
  onTasks: (connectionId: string, tasks: readonly ApiTask[]) => void
}) {
  useEffect(() => {
    const store = connectionStore(entry.metadata.id)
    // A JSON probe alone cannot prove event delivery, but a routine handoff
    // is not an outage while this monitor opens its own stream.
    store.opening("events")
    if (!entry.metadata.ready) {
      onAttention(entry.metadata.id, null)
      onReachability(entry.metadata.id, "offline")
      return
    }
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight: AbortController | null = null
    let generation = 0
    let dirty = false

    const flush = () => {
      if (closed || inFlight || !dirty) return
      dirty = false
      refresh()
    }
    const schedule = (delay = 250) => {
      generation++
      dirty = true
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        flush()
      }, delay)
    }
    const refresh = () => {
      if (closed || inFlight) return
      const controller = new AbortController()
      const requestedGeneration = generation
      inFlight = controller
      void entry.transport.request<ApiTask[]>("/api/tasks", { signal: controller.signal }).then(
        (tasks) => {
          if (!closed && !controller.signal.aborted && requestedGeneration === generation) {
            onAttention(entry.metadata.id, connectionAttention(tasks))
            onReachability(entry.metadata.id, "online")
            onTasks(entry.metadata.id, tasks)
          }
        },
        (error: unknown) => {
          if (!closed && !controller.signal.aborted && requestedGeneration === generation)
            onReachability(entry.metadata.id, classifyConnectionError(error))
        },
      ).finally(() => {
        if (inFlight === controller) inFlight = null
        if (closed) return
        if (timer === null) flush()
      })
    }

    refresh()
    let events: DaemonEventStream | null = null
    try {
      const stream = entry.transport.openEventStream("/api/events")
      events = stream
      stream.onopen = () => {
        if (closed) return
        store.set("events", true)
        onReachability(entry.metadata.id, "online")
        // The initial snapshot may predate the SSE subscription even if its
        // response arrives later. Reconcile once on every open to close that
        // gap, while the in-flight guard keeps the reads serialized.
        schedule(0)
      }
      stream.onmessage = (event) => {
        if (!closed && canChangeTaskList(event.data)) schedule()
      }
      // Probe JSON again to distinguish stream refusal from daemon failures.
      stream.onerror = () => {
        if (closed) return
        store.set("events", false)
        schedule(0)
      }
    } catch {
      store.set("events", false)
      // The next time this connection becomes active, the normal bridge owns recovery.
    }
    return () => {
      closed = true
      store.opening("events")
      if (timer !== null) clearTimeout(timer)
      inFlight?.abort()
      events?.close()
    }
  }, [entry, onAttention, onReachability, onTasks])
  return null
}
