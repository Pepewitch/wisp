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

  const pinnedRef = useRef(pinned)
  useLayoutEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  // A live turn commits many times a frame, and every tail write reads
  // layout. So the write waits for the frame, which still runs before it is
  // painted, happens once however many commits asked, and is skipped when the
  // reader is already on the tail.
  const pinFrame = useRef<number | null>(null)
  const pinToTail = useCallback(() => {
    if (pinFrame.current !== null) return
    pinFrame.current = requestAnimationFrame(() => {
      pinFrame.current = null
      const el = viewport.current
      if (!el || !pinnedRef.current) return
      const tail = el.scrollHeight - el.clientHeight
      if (el.scrollTop < tail - 1) el.scrollTop = tail
    })
  }, [])
  useEffect(() => () => {
    if (pinFrame.current !== null) cancelAnimationFrame(pinFrame.current)
  }, [])

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
    if (pinned && el) pinToTail()
  }, [
    firstTurn,
    focusRequests,
    pinned,
    streamBlocks,
    task?.messages?.length,
    task?.turns.length,
    taskIdentity,
    viewport,
    pinToTail,
  ])

  // The viewport can shrink with no scroll event and no new content: a band
  // above it growing (a new revision, Compare opening) or the composer
  // growing. A pinned reader must stay on the tail.
  useEffect(() => {
    const el = viewport.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(pinToTail)
    observer.observe(el)
    return () => observer.disconnect()
  }, [taskIdentity, pinToTail])

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
