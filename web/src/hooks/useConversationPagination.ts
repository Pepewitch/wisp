import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import type { ConversationDetail } from "@/lib/types"
import type { StreamState } from "@/stream/reducer"

const PIN_THRESHOLD = 60

interface ConversationPaginationOptions {
  connectionId: string
  task: ConversationDetail | null
  streamBlocks: StreamState["blocks"]
  focusRequests: number
  isLoadingOlderTurns: boolean
  onLoadOlderTurns?: () => Promise<unknown>
}

/** Tail pinning, cursor prepends, and search-driven paging for one scroller. */
export function useConversationPagination({
  connectionId,
  task,
  streamBlocks,
  focusRequests,
  isLoadingOlderTurns,
  onLoadOlderTurns,
}: ConversationPaginationOptions) {
  const viewport = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const taskIdentity = `${connectionId}:${task?.id ?? ""}`
  const firstTurn = task?.turns.at(0)?.n
  const pendingPrepend = useRef<{
    taskIdentity: string
    firstTurn: number | undefined
    height: number
    wasPinned: boolean
  } | null>(null)

  useLayoutEffect(() => {
    const el = viewport.current
    const pending = pendingPrepend.current
    if (pending && pending.taskIdentity !== taskIdentity) {
      pendingPrepend.current = null
    } else if (el && pending && firstTurn !== pending.firstTurn) {
      el.scrollTop += el.scrollHeight - pending.height
      pendingPrepend.current = null
      return
    }
    if (pinned && el) el.scrollTop = el.scrollHeight
  }, [
    firstTurn,
    focusRequests,
    pinned,
    streamBlocks,
    task?.messages?.length,
    task?.turns.length,
    taskIdentity,
    viewport,
  ])

  // A task switch and `/log` request each make this a fresh tail read.
  const [seenTask, setSeenTask] = useState(taskIdentity)
  const [seenFocus, setSeenFocus] = useState(focusRequests)
  if (seenTask !== taskIdentity) {
    setSeenTask(taskIdentity)
    setPinned(true)
  }
  if (seenFocus !== focusRequests) {
    setSeenFocus(focusRequests)
    setPinned(true)
  }

  const onScroll = () => {
    const el = viewport.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD)
  }

  const loadOlderTurns = useCallback(() => {
    const el = viewport.current
    if (!onLoadOlderTurns || !el || isLoadingOlderTurns || pendingPrepend.current) return
    const pending = {
      taskIdentity,
      firstTurn,
      height: el.scrollHeight,
      wasPinned: pinned,
    }
    pendingPrepend.current = pending
    setPinned(false)
    void onLoadOlderTurns()
      .then((merged) => {
        if (merged !== false || pendingPrepend.current !== pending) return
        pendingPrepend.current = null
        setPinned(pending.wasPinned)
      })
      .catch(() => {
        if (pendingPrepend.current !== pending) return
        pendingPrepend.current = null
        setPinned(pending.wasPinned)
      })
  }, [
    firstTurn,
    isLoadingOlderTurns,
    onLoadOlderTurns,
    pinned,
    taskIdentity,
  ])

  /** Keep the reader's line still when an expanded group above it grows. */
  const compensate = useCallback((node: HTMLElement | null, before: number) => {
    const el = viewport.current
    if (!el || !node) return
    if (node.getBoundingClientRect().top >= el.getBoundingClientRect().top) return
    el.scrollTop += el.scrollHeight - before
  }, [])

  return {
    viewport,
    pinned,
    onScroll,
    loadOlderTurns,
    compensate,
    jumpToLatest: () => setPinned(true),
  }
}

export function useRevealTurnPage({
  revealTurn,
  firstTurn,
  hasOlderTurns,
  isLoadingOlderTurns,
  olderTurnsError,
  loadOlderTurns,
}: {
  revealTurn: number | null
  firstTurn: number | undefined
  hasOlderTurns: boolean
  isLoadingOlderTurns: boolean
  olderTurnsError: unknown
  loadOlderTurns: () => void
}) {
  useEffect(() => {
    if (
      revealTurn == null ||
      firstTurn == null ||
      revealTurn >= firstTurn ||
      !hasOlderTurns ||
      isLoadingOlderTurns ||
      olderTurnsError
    ) return
    loadOlderTurns()
  }, [
    firstTurn,
    hasOlderTurns,
    isLoadingOlderTurns,
    loadOlderTurns,
    olderTurnsError,
    revealTurn,
  ])
}
