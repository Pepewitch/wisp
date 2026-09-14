import type { ConversationDetail, TaskMessage, Turn } from "./types"

function mergeBy<T>(older: T[], newer: T[], key: (value: T) => string | number): T[] {
  const merged = new Map<string | number, T>()
  for (const value of older) merged.set(key(value), value)
  for (const value of newer) merged.set(key(value), value)
  return [...merged.values()]
}

/**
 * Keep current task metadata from the newest response while prepending an
 * older cursor page. Retries are idempotent, and both collections retain the
 * daemon's chronological order.
 */
export function prependConversationPage(
  current: ConversationDetail,
  older: ConversationDetail,
): ConversationDetail {
  return {
    ...current,
    turns: mergeBy<Turn>(older.turns, current.turns, (turn) => turn.n),
    messages: mergeBy<TaskMessage>(older.messages ?? [], current.messages ?? [], (message) => message.id),
    has_older_turns: older.has_older_turns === true,
    older_turns_before: older.older_turns_before ?? null,
  }
}

/**
 * A realtime refresh replaces the newest page and its pending-message scope,
 * while preserving only rows that belong to previously loaded older pages.
 */
export function refreshConversationPage(
  current: ConversationDetail,
  fresh: ConversationDetail,
): ConversationDetail {
  const firstFreshTurn = fresh.turns.at(0)?.n
  if (firstFreshTurn === undefined) return fresh
  const historicalTurns = current.turns.filter((turn) => turn.n < firstFreshTurn)
  const historicalMessages = (current.messages ?? []).filter(
    (message) => message.turn_n !== null && message.turn_n < firstFreshTurn,
  )
  return {
    ...fresh,
    turns: mergeBy<Turn>(historicalTurns, fresh.turns, (turn) => turn.n),
    messages: mergeBy<TaskMessage>(
      historicalMessages,
      fresh.messages ?? [],
      (message) => message.id,
    ),
    has_older_turns: current.has_older_turns,
    older_turns_before: current.older_turns_before,
  }
}
