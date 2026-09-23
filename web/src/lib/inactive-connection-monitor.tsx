import { useEffect } from "react"

import { connectionAttention, type ConnectionAttention } from "@/lib/connection-attention"
import { classifyConnectionError, type ConnectionReachability } from "@/lib/connection-reachability"
import { connectionStore } from "@/lib/conn"
import type { DesktopConnectionEntry } from "@/lib/desktop-connections"
import type { DaemonEventStream } from "@/lib/transport"
import type { ApiTask } from "@/lib/types"

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
    // A JSON probe alone cannot prove event delivery.
    store.set("events", false)
    if (!entry.metadata.ready) {
      onAttention(entry.metadata.id, null)
      onReachability(entry.metadata.id, "offline")
      return
    }
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = () => {
      void entry.transport.request<ApiTask[]>("/api/tasks").then(
        (tasks) => {
          if (!closed) {
            onAttention(entry.metadata.id, connectionAttention(tasks))
            onReachability(entry.metadata.id, "online")
            onTasks(entry.metadata.id, tasks)
          }
        },
        (error: unknown) => {
          if (!closed)
            onReachability(entry.metadata.id, classifyConnectionError(error))
        }
      )
    }
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(refresh, 250)
    }

    refresh()
    let events: DaemonEventStream | null = null
    try {
      const stream = entry.transport.openEventStream("/api/events")
      events = stream
      stream.onopen = () => {
        store.set("events", true)
        onReachability(entry.metadata.id, "online")
        refresh()
      }
      stream.onmessage = schedule
      // Probe JSON again to distinguish stream refusal from daemon failures.
      stream.onerror = () => {
        store.set("events", false)
        refresh()
      }
    } catch {
      // The next time this connection becomes active, the normal bridge owns recovery.
    }
    return () => {
      closed = true
      store.set("events", false)
      if (timer !== null) clearTimeout(timer)
      events?.close()
    }
  }, [entry, onAttention, onReachability, onTasks])
  return null
}
