import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"

import { useDesktopConnections } from "@/lib/desktop-connections"
import {
  usePendingAttachments,
  type PendingAttachments,
} from "@/lib/attachments"
import {
  readDraft,
  writeDraft,
  writePendingAttachmentCount,
} from "@/lib/drafts"
import { useDaemonRuntime } from "@/lib/runtime"

/** Keep desktop drafts in webview memory while preserving normal web behavior. */
export function useRememberedDraft(taskId: string | null) {
  const runtime = useDaemonRuntime()
  const remember = useDesktopConnections() !== null
  const [value, setValue] = useState(() =>
    remember ? readDraft(runtime.connectionId, taskId) : ""
  )
  const latest = useRef(value)
  const setRememberedValue = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next
        latest.current = resolved
        if (remember) writeDraft(runtime.connectionId, taskId, resolved)
        return resolved
      })
    },
    [remember, runtime.connectionId, taskId]
  )
  useEffect(
    () => () => {
      if (remember) writeDraft(runtime.connectionId, taskId, latest.current)
    },
    [remember, runtime.connectionId, taskId]
  )
  return [value, setRememberedValue] as const
}

/** Share only a count with removal confirmation; attachment bytes stay local. */
export function useDesktopPendingAttachments({
  taskId,
  harness,
  hasImage,
  imageNote,
}: {
  taskId: string | null
  harness: string | null
  hasImage: boolean | undefined
  imageNote?: string
}): PendingAttachments {
  const runtime = useDaemonRuntime()
  const remember = useDesktopConnections() !== null
  const attachments = usePendingAttachments({
    harness,
    hasImage,
    imageNote,
    rememberKey: remember
      ? `${runtime.connectionId}\u0000${taskId ?? ""}`
      : undefined,
  })
  useEffect(() => {
    if (!remember) return
    writePendingAttachmentCount(
      runtime.connectionId,
      taskId,
      attachments.list.length
    )
  }, [attachments.list.length, remember, runtime.connectionId, taskId])
  return attachments
}
