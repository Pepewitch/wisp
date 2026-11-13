import { useState } from "react"

import type { TaskMessage } from "@/lib/types"

export interface MessageGroups {
  /** still waiting for a turn, or cancelled after an unconfirmed native admission */
  queuedMessages: TaskMessage[]
  /** messages a RUNNING turn accepted, by that turn */
  steeredMessages: Map<number, TaskMessage[]>
  /** turns that replayed a row whose prior native admission was indeterminate */
  uncertainStarts: Set<number>
}

const sameMessages = (left: TaskMessage[], right: TaskMessage[]) =>
  left.length === right.length && left.every((message, index) => message === right[index])

/**
 * Where each of a task's messages renders. Every message event refetches the
 * task, and Query's structural sharing hands back the same row for a message
 * that did not change, so a turn whose steered rows are all the same keeps
 * last time's array: its memoized `TurnBlock` has nothing to redraw.
 */
export function groupMessages(messages: TaskMessage[] | undefined, previous: MessageGroups | null): MessageGroups {
  const queuedMessages: TaskMessage[] = []
  const steeredMessages = new Map<number, TaskMessage[]>()
  const uncertainStarts = new Set<number>()
  for (const message of messages ?? []) {
    if (message.status === "queued" || (message.status === "cancelled" && message.delivery_uncertain)) {
      queuedMessages.push(message)
    } else if (message.delivery === "steered" && message.turn_n !== null) {
      const group = steeredMessages.get(message.turn_n)
      if (group) group.push(message)
      else steeredMessages.set(message.turn_n, [message])
    } else if (message.delivery === "started" && message.turn_n !== null && message.delivery_uncertain) {
      uncertainStarts.add(message.turn_n)
    }
  }
  for (const [turn, group] of steeredMessages) {
    const before = previous?.steeredMessages.get(turn)
    if (before && sameMessages(before, group)) steeredMessages.set(turn, before)
  }
  return { queuedMessages, steeredMessages, uncertainStarts }
}

/** `groupMessages` for one conversation, carrying each turn's array across refetches. */
export function useMessageGroups(messages: TaskMessage[] | undefined): MessageGroups {
  const [held, setHeld] = useState(() => ({ messages, groups: groupMessages(messages, null) }))
  if (held.messages !== messages) {
    const next = { messages, groups: groupMessages(messages, held.groups) }
    setHeld(next)
    return next.groups
  }
  return held.groups
}
