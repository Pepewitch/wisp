import type { ActivityEvent } from "./adapters/types";
import { summarize } from "./text";

/**
 * Wisp's own marker line for a message that was steered INTO a running turn.
 *
 * The turn log is the only ordered record of what happened inside a turn, and
 * a mid-turn steer is an event in that order — not a fact about the prompt.
 * The line is written to the same file descriptor the harness's output goes
 * to, at native admission, so it sits exactly between the bytes that came
 * before the delivery and the ones the harness produced in response. That is
 * what makes the placement true rather than a render-time guess, and it
 * survives replay, reconnect and a settled turn's on-demand refetch for free.
 *
 * Plain text and never JSON, like the attach note above it: every adapter's
 * parse skips non-JSON lines, so `turn.result`, session capture and usage are
 * untouched, and `wisp log` renders it as one note.
 *
 * The preview is for a person reading the log. The conversation resolves the
 * id against the message row, which owns the full text, its attachments and
 * its delivery wording — a log line must never be the reason the UI claims a
 * delivery the database did not record.
 */
const STEER_NOTE = /^· steer ([A-Za-z0-9_-]{1,80}): ?(.*)$/;

const PREVIEW_CHARS = 200;

export function formatSteerNote(messageId: string, text: string): string {
  return `· steer ${messageId}: ${summarize(text, PREVIEW_CHARS)}`;
}

export interface SteerNote {
  messageId: string;
  /** One collapsed line of the message, for log readers and as a UI fallback. */
  preview: string;
}

/** Recognize a steer marker in a log line. Anything else is harness output. */
export function parseSteerNote(line: string): SteerNote | null {
  const match = STEER_NOTE.exec(line.trim());
  if (!match) return null;
  return { messageId: match[1]!, preview: match[2] ?? "" };
}

/**
 * The canonical event a steer marker projects to, recognized before any
 * harness projection runs: this is the one line in the log that Wisp itself
 * wrote, and its POSITION is the fact it carries. Keyed by the message id, so
 * a re-read of the same log rebuilds the same anchor instead of a second one.
 */
export function steerActivityEvent(line: string): ActivityEvent | null {
  const note = parseSteerNote(line);
  return note ? { kind: "message", id: note.messageId, parentId: null, text: note.preview } : null;
}
