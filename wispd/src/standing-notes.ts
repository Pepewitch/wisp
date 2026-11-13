import { createHash } from "node:crypto";
import type { TurnNotes } from "./autopilot/store";
import type { Task } from "./types";

/**
 * Wisp's standing notes — the image-output reminder, and autopilot's notes
 * while a switch is on — go into a conversation ONCE, not in front of every
 * turn. A long-lived task is mostly turns Wisp itself started (subtask
 * reports, heartbeats, autopilot rounds), and each repeat was text the model
 * already had: 65–382 tokens a turn, measured at 87k–512k tokens over one
 * real 1,341-turn task.
 *
 * They go out again whenever the conversation may no longer hold them:
 *
 *  - a new conversation — a fresh context (`/fresh`, a harness switch), or no
 *    session to resume yet;
 *  - another session in the same context (a harness that minted one);
 *  - their text changed: a switch turned on or off, a merge under way. They
 *    are then sent whole, saying they replace the earlier ones, so a note
 *    that is gone is gone for the agent too;
 *  - a compaction, a slash command, or a turn that did not end well: the
 *    conversation may have lost them, or never received them;
 *  - a daemon restart: the record is this daemon's memory, on purpose.
 *
 * A one-time note (a branch finished after a merge) is sent once as always,
 * and is not part of what the record compares.
 *
 * None of this is ever moved into a system prompt flag: text that changes
 * there invalidates the harness's prompt cache for the whole conversation.
 */
interface Sent {
  contextN: number;
  /** The session the notes went into; null when the turn that carried them started it. */
  sessionId: string | null;
  hash: string;
}

const sent = new Map<string, Sent>();

export const NOTES_CHANGED = "Wisp's standing notes changed; these replace the earlier ones.";
export const NOTES_RETIRED = "Wisp's earlier standing notes no longer apply.";

function hashOf(notes: string[]): string {
  return createHash("sha256").update(notes.join("\n")).digest("hex");
}

/** Whether `task`'s next turn continues the conversation the record was made in. */
function sameConversation(task: Pick<Task, "context_n" | "session_id">, record: Sent): boolean {
  if (record.contextN !== task.context_n || !task.session_id) return false;
  return record.sessionId === null || record.sessionId === task.session_id;
}

/**
 * The notes a plain turn carries, in autopilot's order: a one-time note
 * always, standing ones only when this conversation needs them. `delivered`
 * records them once the harness really has the input (runner: after the spawn
 * or the adoption's write), and spends autopilot's one-time note.
 */
export function standingTurnNotes(
  task: Pick<Task, "id" | "context_n" | "session_id">,
  autopilot: TurnNotes | null,
  standing: string[],
): TurnNotes {
  const once = new Set(autopilot?.once ?? []);
  const notes = [...(autopilot?.notes ?? []), ...standing];
  const kept = notes.filter((note) => !once.has(note));
  const hash = hashOf(kept);
  const record = sent.get(task.id);
  const continued = record !== undefined && sameConversation(task, record);
  const lines = continued && record.hash === hash
    ? notes.filter((note) => once.has(note))
    : continued
      ? kept.length > 0 ? [NOTES_CHANGED, ...notes] : [NOTES_RETIRED, ...notes]
      : notes;
  return {
    notes: lines,
    once: [...once],
    marked: autopilot?.marked === true,
    delivered() {
      autopilot?.delivered();
      sent.set(task.id, { contextN: task.context_n, sessionId: task.session_id, hash });
    },
  };
}

/** The conversation may have lost the notes, or never got them: the next plain turn sends them whole. */
export function forgetStandingNotes(taskId: string): void {
  sent.delete(taskId);
}

/** Test seam: a daemon restart, which forgets every record. */
export function resetStandingNotes(): void {
  sent.clear();
}
