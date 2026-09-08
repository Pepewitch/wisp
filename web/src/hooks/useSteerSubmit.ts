import { useRef, type Dispatch, type SetStateAction } from "react"

import { useInterruptTask, useSendMessage } from "@/hooks/mutations"
import { failureNote, type SteerNote } from "@/hooks/useSteerCommands"
import type { AttachmentPayload, PendingAttachments } from "@/lib/attachments"
import type { ApiTask, SendResponse } from "@/lib/types"
import type { SlashToken } from "@/lib/slash"

interface PendingSend {
  taskId: string
  message: string
  suffixPromptId: string | null
  attachments: AttachmentPayload[] | undefined
  clientMessageId: string
}

function sameAttachments(a: AttachmentPayload[] | undefined, b: AttachmentPayload[] | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((item, index) => item.name === b[index]?.name && item.dataBase64 === b[index]?.dataBase64)
}

export function useSteerSubmit({
  task,
  canSend,
  canStop,
  value,
  suffixPromptId,
  attachments,
  onSend,
  onInterrupt,
  onSent,
  setValue,
  setSending,
  setNote,
  setPalette,
}: {
  task: ApiTask | null
  canSend: boolean
  canStop: boolean
  value: string
  suffixPromptId: string | null
  attachments: PendingAttachments
  onSend?: (message: string, attachments?: AttachmentPayload[], suffixPromptId?: string) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onSent: (taskId: string) => void
  setValue: Dispatch<SetStateAction<string>>
  setSending: Dispatch<SetStateAction<boolean>>
  setNote: Dispatch<SetStateAction<SteerNote | null>>
  setPalette: Dispatch<SetStateAction<SlashToken | null>>
}) {
  const sendMessage = useSendMessage()
  const interruptTask = useInterruptTask()
  const pendingSend = useRef<PendingSend | null>(null)

  const send = () => {
    if (!canSend || !task) return
    const id = task.id
    const message = value
    const payloads = attachments.payloads()
    const previous = pendingSend.current
    const clientMessageId =
      previous?.taskId === id &&
      previous.message === message &&
      previous.suffixPromptId === suffixPromptId &&
      sameAttachments(previous.attachments, payloads)
        ? previous.clientMessageId
        : crypto.randomUUID()
    pendingSend.current = { taskId: id, message, suffixPromptId, attachments: payloads, clientMessageId }
    setPalette(null)
    setNote(null)
    setSending(true)
    const done = (result: SendResponse | void) => {
      pendingSend.current = null
      setSending(false)
      setValue("")
      onSent(id)
      attachments.clear()
      if (result?.disposition) {
        const delivery =
          result.disposition === "steered"
            ? "sent to the running turn"
            : result.disposition === "queued-next"
              ? "queued for the next turn"
              : `started turn ${result.message.turn_n ?? result.turn_count}`
        const text = result.message.delivery_uncertain
          ? `${delivery}; prior delivery may already have succeeded`
          : delivery
        setNote({ taskId: id, tone: "muted", text })
      }
    }
    const failed = (error: unknown) => {
      setSending(false)
      setNote(failureNote(id, error))
    }
    const postMessage = () => {
      if (!onSend) {
        return sendMessage.mutateAsync({
          id,
          message,
          clientMessageId,
          ...(suffixPromptId ? { suffixPromptId } : {}),
          ...(payloads ? { attachments: payloads } : {}),
        })
      }
      try {
        return Promise.resolve(
          suffixPromptId ? onSend(message, payloads, suffixPromptId) : onSend(message, payloads),
        )
      } catch (error) {
        return Promise.reject(error)
      }
    }
    // Sending is never an implicit stop. The daemon either admits this to a
    // verified live channel or keeps it durably for the next turn.
    void postMessage().then(done, failed)
  }

  const stop = () => {
    if (!canStop || !task) return
    const id = task.id
    setPalette(null)
    setNote(null)
    setSending(true)
    const request = onInterrupt ? Promise.resolve().then(onInterrupt) : interruptTask.mutateAsync(id)
    void request.then(
      () => setSending(false),
      (error) => {
        setSending(false)
        setNote(failureNote(id, error))
      },
    )
  }

  return { send, stop }
}
