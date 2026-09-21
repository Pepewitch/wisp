import { useRef, type Dispatch, type SetStateAction } from "react"

import { useInterruptTask, useSendMessage } from "@/hooks/mutations"
import { failureNote, type SteerNote } from "@/hooks/useSteerCommands"
import {
  discardAttachmentPayloads,
  type AttachmentPayload,
  type PendingAttachments,
} from "@/lib/attachments"
import { useDaemonTransport } from "@/lib/runtime"
import { COMPACTING_TEXT } from "@/lib/compaction"
import type { ApiTask, SendResponse } from "@/lib/types"
import type { SlashToken } from "@/lib/slash"

interface PendingSend {
  taskId: string
  message: string
  suffixPromptId: string | null
  attachments: AttachmentPayload[] | undefined
  clientMessageId: string
  agent: AgentSubmission | null
}

export interface AgentSubmission {
  harness: string
  model: string
  effort: string | null
  fast: boolean
  startFreshContext: boolean
}

const sameAgent = (a: AgentSubmission | null, b: AgentSubmission | null) =>
  a?.harness === b?.harness &&
  a?.model === b?.model &&
  a?.effort === b?.effort &&
  a?.fast === b?.fast &&
  a?.startFreshContext === b?.startFreshContext

function sameAttachments(a: AttachmentPayload[] | undefined, b: AttachmentPayload[] | undefined) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((item, index) =>
    item.name === b[index]?.name && item.contentHash === b[index]?.contentHash
  )
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
  onSend?: (
    message: string,
    attachments?: AttachmentPayload[],
    suffixPromptId?: string,
    agent?: AgentSubmission,
  ) => Promise<void> | void
  onInterrupt?: () => Promise<void> | void
  onSent: (taskId: string) => void
  setValue: Dispatch<SetStateAction<string>>
  setSending: Dispatch<SetStateAction<boolean>>
  setNote: Dispatch<SetStateAction<SteerNote | null>>
  setPalette: Dispatch<SetStateAction<SlashToken | null>>
}) {
  const sendMessage = useSendMessage()
  const interruptTask = useInterruptTask()
  const transport = useDaemonTransport()
  const discardUpload = (uploadId: string) =>
    transport.request(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: "DELETE" })
  const pendingSend = useRef<PendingSend | null>(null)

  const send = (agent: AgentSubmission | null = null) => {
    if (!canSend || !task) return
    const id = task.id
    const message = value
    setPalette(null)
    setNote(null)
    setSending(true)
    // Raw bytes stream only when the user asks for work; no base64 copy enters
    // composer state or the eventual JSON request.
    void attachments.payloads(transport.upload, discardUpload).then(
      (payloads) => post(id, message, payloads, agent),
      (error) => {
        setSending(false)
        setNote(failureNote(id, error))
      },
    )
  }

  const post = (
    id: string,
    message: string,
    payloads: AttachmentPayload[] | undefined,
    agent: AgentSubmission | null,
  ) => {
    const previous = pendingSend.current
    const clientMessageId =
      previous?.taskId === id &&
      previous.message === message &&
      previous.suffixPromptId === suffixPromptId &&
      sameAgent(previous.agent, agent) &&
      sameAttachments(previous.attachments, payloads)
        ? previous.clientMessageId
        : crypto.randomUUID()
    pendingSend.current = { taskId: id, message, suffixPromptId, attachments: payloads, clientMessageId, agent }
    const done = (result: SendResponse | void) => {
      pendingSend.current = null
      setSending(false)
      setValue("")
      onSent(id)
      attachments.clear()
      if (result?.disposition) {
        if (result.operation === "compact") {
          const turn = result.message.turn_n
          const delivery = result.disposition === "queued-next"
            ? "compaction queued for the next turn"
            : COMPACTING_TEXT
          setNote({
            taskId: id,
            tone: "muted",
            text: result.message.delivery_uncertain
              ? `${delivery}; prior delivery may already have succeeded`
              : delivery,
            ...(turn !== null ? { compactTurn: turn } : {}),
          })
          return
        }
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
      if (payloads) void discardAttachmentPayloads(payloads, discardUpload)
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
          ...(agent ?? {}),
        })
      }
      try {
        return Promise.resolve(
          agent
            ? onSend(message, payloads, suffixPromptId ?? undefined, agent)
            : suffixPromptId
              ? onSend(message, payloads, suffixPromptId)
              : onSend(message, payloads),
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
    setNote({ taskId: id, tone: "muted", text: "Stopping…" })
    setSending(true)
    const request = onInterrupt ? Promise.resolve().then(onInterrupt) : interruptTask.mutateAsync(id)
    void request.then(
      () => {
        setSending(false)
        setNote({ taskId: id, tone: "muted", text: "Stopped" })
      },
      (error) => {
        setSending(false)
        setNote(failureNote(id, error))
      },
    )
  }

  return { send, stop }
}
