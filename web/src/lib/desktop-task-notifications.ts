import { useCallback, useEffect, type RefObject } from "react"

import type { DesktopBridge } from "@/lib/desktop-bridge"
import type { ConnectionState } from "@/lib/desktop-connections"
import {
  applyTaskFocusRequest,
  publishTaskTransitions,
} from "@/lib/desktop-notifications"
import { readSelectedTask } from "@/lib/task-selection"
import { taskTransitions } from "@/lib/task-transitions"
import type { ApiTask } from "@/lib/types"

/**
 * The desktop provider's notification seam: every task list it sees (active
 * tab or background monitor) is diffed for finished turns, and a clicked
 * banner comes back through the native focus event. Returns the observer the
 * provider hands to both kinds of view.
 */
export function useDesktopTaskNotifications(
  bridge: DesktopBridge,
  stateRef: RefObject<ConnectionState>,
  select: (connectionId: string) => Promise<void>
): (connectionId: string, tasks: readonly ApiTask[]) => void {
  const observeTaskStates = useCallback(
    (connectionId: string, tasks: readonly ApiTask[]) => {
      const transitions = taskTransitions.observe(connectionId, tasks)
      if (transitions.length === 0) return
      const current = stateRef.current
      const entry = current.connections.find(
        (candidate) => candidate.metadata.id === connectionId
      )
      if (!entry) return
      publishTaskTransitions({
        bridge,
        connectionId,
        connectionName: entry.metadata.name,
        transitions,
        context: {
          windowFocused: document.hasFocus(),
          activeConnectionId: current.activeId,
          selectedTaskId: readSelectedTask(connectionId),
        },
      })
    },
    [bridge, stateRef]
  )
  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null
    bridge
      .onFocusTask((request) => {
        const current = stateRef.current
        applyTaskFocusRequest(request, {
          connectionIds: current.connections.map((entry) => entry.metadata.id),
          activeConnectionId: current.activeId,
          select,
        })
      })
      .then(
        (unlisten) => {
          if (disposed) unlisten()
          else stop = unlisten
        },
        () => {
          // Without the native event there is no click to answer; banners still post.
        }
      )
    return () => {
      disposed = true
      stop?.()
    }
  }, [bridge, select, stateRef])
  return observeTaskStates
}
