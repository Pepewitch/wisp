import { useEffect, useRef, type RefObject } from "react"

import type { TaskMessage } from "@/lib/types"
import type { UiIntents } from "@/lib/ui-intents"

/** Message ids are the daemon's own (`m` + base36); anything else is not ours to put in a selector. */
const MESSAGE_ID = /^[A-Za-z0-9_-]+$/

/**
 * The Autopilot tab's "View message": scroll the conversation to the message
 * an auto-fix round queued. Wherever it is now — still queued at the tail,
 * steered into a running turn, or the prompt of the turn it started.
 *
 * A turn that is not mounted yet (an older page) is handed to find-in-task
 * with the message's first line, which already knows how to load pages until
 * a named turn is mounted. A message this view has never heard of is a shrug,
 * like any other missed intent.
 */
export function useRevealMessage(
  scroller: RefObject<HTMLElement | null>,
  intents: UiIntents,
  messages: readonly TaskMessage[],
): void {
  const answered = useRef(intents.messageRevealRequest()?.seq ?? 0)
  // the subscription must see the current rows without re-subscribing on every refetch
  const rows = useRef(messages)
  useEffect(() => {
    rows.current = messages
  }, [messages])

  useEffect(() => {
    return intents.subscribe(() => {
      const request = intents.messageRevealRequest()
      if (!request || request.seq === answered.current) return
      answered.current = request.seq
      const id = request.messageId
      const root = scroller.current
      if (!root || !MESSAGE_ID.test(id)) return
      const placed = root.querySelector<HTMLElement>(`[data-message="${id}"], [data-steered-message="${id}"]`)
      if (placed) {
        placed.scrollIntoView?.({ block: "center" })
        return
      }
      const message = rows.current.find((row) => row.id === id)
      if (message?.turn_n === null || message?.turn_n === undefined) return
      const turn = root.querySelector<HTMLElement>(`[data-turn="${message.turn_n}"]`)
      if (turn) {
        turn.scrollIntoView?.({ block: "start" })
        return
      }
      const firstLine = message.text.split("\n").find((line) => line.trim() !== "")?.trim().slice(0, 80)
      if (firstLine) intents.openFind(firstLine, message.turn_n)
    })
  }, [intents, scroller])
}
