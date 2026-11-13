import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { fetchTurnActivity } from "@/lib/activity"
import { useDaemonRuntime } from "@/lib/runtime"

/**
 * How long a settled turn's timeline stays cached once nothing shows it. A
 * settled log never changes, so the bound is memory, not freshness.
 */
export const SETTLED_ACTIVITY_GC_MS = 5 * 60_000

/**
 * A settled turn's timeline, on demand (§5 rule 2), through the query cache.
 *
 * It used to be streamed again on every **Show activity** and thrown away on
 * **Hide activity**, so reading a long turn twice cost its whole log twice. A
 * settled log is immutable, so the cache never considers it stale; hiding
 * only stops showing it, and the cache lets it go a while after nothing does.
 * The live turn's own stream seeds it at turn end (`useLogStream`).
 *
 * `autoLoad` opens it when it becomes true, the way a click would: a failed
 * turn, or a turn find-in-task was handed. Hiding it afterwards sticks.
 */
export function useSettledActivity({ taskId, turn, enabled, autoLoad }: {
  taskId: string
  turn: number
  /** false while the live stream draws this turn, or when its log is gone */
  enabled: boolean
  autoLoad: boolean
}) {
  const { transport, qk } = useDaemonRuntime()
  const [shown, setShown] = useState(autoLoad)
  const [seenAutoLoad, setSeenAutoLoad] = useState(autoLoad)
  if (seenAutoLoad !== autoLoad) {
    setSeenAutoLoad(autoLoad)
    if (autoLoad) setShown(true)
  }
  const wanted = enabled && shown
  const query = useQuery({
    queryKey: qk.activity(taskId, turn),
    queryFn: ({ signal }) => fetchTurnActivity(taskId, turn, { transport, signal }),
    enabled: wanted,
    staleTime: Infinity,
    gcTime: SETTLED_ACTIVITY_GC_MS,
    // a failure leaves the turn collapsed, and the next click asks again
    retry: false,
  })
  return {
    activity: wanted ? (query.data ?? null) : null,
    loading: wanted && query.data === undefined && query.isFetching,
    show: () => {
      setShown(true)
      if (query.isError) void query.refetch()
    },
    hide: () => setShown(false),
  }
}
