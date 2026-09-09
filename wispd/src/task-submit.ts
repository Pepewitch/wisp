import {
  attachmentManifest,
  removeMessageAttachments,
  taskMessageAttachmentsFingerprint,
  type DecodedAttachment,
  writeMessageAttachments,
} from "./attachments"
import {
  activeLiveInput,
  clearPendingDelivery,
  pendingDelivery,
  setPendingDelivery,
} from "./live-input"
import {
  claimTaskMessageForSteering,
  createTaskMessageWithAgent,
  getTask,
  getTaskMessage,
  markTaskMessageDelivered,
  newTaskMessageId,
  releaseTaskMessageClaim,
  runningTurn,
  type TaskAgentSelection,
} from "./store"
import type { SendResult, Task, TaskMessage } from "./types"

function sameMessage(
  existing: TaskMessage,
  task: Task,
  text: string,
  attachmentHash: string,
): boolean {
  return (
    existing.task_id === task.id &&
    existing.text === text &&
    existing.context_n === task.context_n &&
    existing.harness === task.harness &&
    existing.model === task.model &&
    existing.effort === task.effort &&
    (existing.attachment_hash === "" ||
      existing.attachment_hash === attachmentHash)
  )
}

async function reuseTaskMessage(
  existing: TaskMessage,
  task: Task,
  text: string,
  attachmentHash: string,
): Promise<TaskMessage> {
  if (!sameMessage(existing, task, text, attachmentHash)) {
    throw new Error(`message id ${existing.id} was already used for different content`)
  }
  if (existing.status === "queued" && existing.claim !== null) {
    await pendingDelivery(task.id)
  }
  const current = getTaskMessage(existing.id)!
  if (current.status === "cancelled") {
    throw new Error(`message id ${existing.id} was cancelled`)
  }
  return current
}

/** Resolve a stable retry or persist a new submission before delivery. */
export async function persistTaskSubmission(
  task: Task,
  text: string,
  attachments: DecodedAttachment[],
  clientMessageId?: string,
  agent?: TaskAgentSelection,
): Promise<{ task: Task; message: TaskMessage }> {
  const id = clientMessageId ?? newTaskMessageId()
  const attachmentHash = taskMessageAttachmentsFingerprint(attachments)
  const existing = getTaskMessage(id)
  if (existing) {
    // A stable-id retry: the first attempt committed the switch WITH the
    // message (one transaction), so the stored task row is already the
    // resolved agent. Compare against it, not the caller's pre-switch copy.
    const storedTask = getTask(existing.task_id) ?? task
    return { task: storedTask, message: await reuseTaskMessage(existing, storedTask, text, attachmentHash) }
  }

  try {
    removeMessageAttachments(task.id, id)
    const stored =
      attachments.length > 0
        ? writeMessageAttachments(task.id, id, attachments)
        : []
    return createTaskMessageWithAgent(
      {
        id,
        taskId: task.id,
        text,
        attachmentHash,
        attachmentsJson: attachmentManifest(stored),
      },
      agent ?? {
        harness: task.harness,
        model: task.model,
        effort: task.effort,
        freshContext: false,
      },
    )
  } catch (error) {
    if (!getTaskMessage(id)) removeMessageAttachments(task.id, id)
    throw error
  }
}

export interface RunningDelivery {
  running: boolean
  result: SendResult | null
}

/** Admit an unchanged-agent message to a verified live turn, or leave it queued. */
export async function deliverToRunningTurn(
  task: Task,
  message: TaskMessage,
): Promise<RunningDelivery> {
  if (message.status !== "queued") {
    return {
      running: false,
      result: {
        disposition: message.delivery ?? "queued-next",
        message,
      },
    }
  }
  const running = runningTurn(task.id)
  if (!running) return { running: false, result: null }
  const sameAgent =
    running.context_n === message.context_n &&
    running.harness === message.harness &&
    running.requested_model === message.model &&
    running.requested_effort === message.effort
  const live = activeLiveInput(task.id)
  if (!sameAgent || live?.turnId !== running.id) {
    return { running: true, result: null }
  }

  const claimed = claimTaskMessageForSteering(
    message.id,
    task.id,
    live.turn,
  )
  if (!claimed) {
    return {
      running: true,
      result: {
        disposition: "queued-next",
        message: getTaskMessage(message.id)!,
      },
    }
  }
  const previous = pendingDelivery(task.id) ?? Promise.resolve()
  const delivery = previous
    .then(() => live.send(claimed))
    .then(() => {
      markTaskMessageDelivered(message.id, "steered", live.turn)
    })
    .catch((error) => {
      releaseTaskMessageClaim(message.id, task.id, true)
      console.warn(
        `[wisp] task ${task.id}: live delivery failed; keeping ${message.id} queued: ${String(error)}`,
      )
    })
  setPendingDelivery(task.id, delivery)
  await delivery
  clearPendingDelivery(task.id, delivery)
  const delivered = getTaskMessage(message.id)!
  return {
    running: true,
    result: {
      disposition:
        delivered.delivery === "steered" ? "steered" : "queued-next",
      message: delivered,
    },
  }
}
