import { useState } from "react"

import { ArrowUp, Dismiss, Pencil } from "@/components/icons"
import { MessageAttachments } from "@/components/message-attachments"
import { BUBBLE_ACTION, PersonBubble, UserMessageCopyButton } from "@/components/person-bubble"
import { useCancelQueuedMessage, useSendQueuedMessageNow, useUpdateQueuedMessage } from "@/hooks/mutations"
import { useHarnessFeatures } from "@/hooks/queries"
import type { TaskMessage } from "@/lib/types"

/**
 * A message waiting in the task's queue: the person's words, where their
 * delivery stands, and the controls that still apply to it — edit, cancel,
 * and send now, which lifts a next-turn hold and delivers it the way a send
 * does mid-turn (steered in, or started by stopping the turn).
 */
export function QueuedMessage({
  taskId,
  message,
  archived,
  assetsRemoved,
}: {
  taskId: string
  message: TaskMessage
  archived: boolean
  assetsRemoved: boolean
}) {
  const update = useUpdateQueuedMessage()
  const cancel = useCancelQueuedMessage()
  const sendNow = useSendQueuedMessageNow()
  // a workflow's generated instruction is sent by its workflow, never by hand
  const canSendNow = useHarnessFeatures().data?.steerDelivery === true && !message.workflow_id
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const busy = update.isPending || cancel.isPending || sendNow.isPending
  const cancelled = message.status === "cancelled"
  const failure = update.error ?? cancel.error ?? sendNow.error

  const save = () => {
    const text = draft.trim()
    if (!text || text === message.text) {
      setEditing(false)
      setDraft(message.text)
      return
    }
    update.mutate(
      { taskId, messageId: message.id, message: text },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <article data-message={message.id} data-status={message.status} className="pt-[30px]">
      {/* No time to state: this one has not been SENT. What it states instead
          is where its delivery stands, and that goes in the caption like every
          other fact — the bubble holds the person's words and nothing else.
          Edit and cancel join copy in the floating toolbar, because they are
          controls. While editing they come back inside — the bubble is a form
          then, and a form owns its own Save. */}
      <PersonBubble
        caption={
          <span>
            {archived
              ? "not delivered; task is archived"
              : cancelled
                ? "retry cancelled; prior delivery may already have succeeded"
              : message.delivery_uncertain
                ? "queued for retry; prior delivery may already have succeeded"
              : message.deferred
                ? "held for the next turn"
                : "queued for the next turn"}
          </span>
        }
        actions={
          !editing && (
            <>
              <UserMessageCopyButton text={message.text} />
              {!archived && !cancelled && (
                <>
                  {canSendNow && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label="Send queued message now"
                      title="Send now: into the running turn, or stop the turn and send it"
                      className={BUBBLE_ACTION}
                      onClick={() => sendNow.mutate({ taskId, messageId: message.id })}
                    >
                      <ArrowUp />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Edit queued message"
                    title="Edit queued message"
                    className={BUBBLE_ACTION}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Cancel queued message"
                    title="Cancel queued message"
                    className={BUBBLE_ACTION}
                    onClick={() => cancel.mutate({ taskId, messageId: message.id })}
                  >
                    <Dismiss />
                  </button>
                </>
              )}
            </>
          )
        }
      >
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-16 w-full resize-y bg-transparent text-[12.5px] leading-relaxed text-foreground/90 outline-none"
          />
        ) : (
          <div className="whitespace-pre-wrap">{message.text}</div>
        )}
        {editing && (
          <div className="mt-1.5 flex items-center justify-end gap-2 text-[10.5px] text-faint">
            <button type="button" disabled={busy} className="hover:text-foreground" onClick={save}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              className="hover:text-foreground"
              onClick={() => {
                setEditing(false)
                setDraft(message.text)
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </PersonBubble>
      <MessageAttachments
        taskId={taskId}
        messageId={message.id}
        attachments={message.attachments}
        archived={assetsRemoved}
        cancelled={cancelled}
      />
      {failure && (
        <div className="mt-1 text-right text-[10.5px] text-state-failed">
          {failure instanceof Error ? failure.message : "Request failed"}
        </div>
      )}
    </article>
  )
}
