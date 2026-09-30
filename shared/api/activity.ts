/**
 * The harness-neutral activity the daemon's adapter boundary emits: the log
 * stream's `format=activity` frames, which the conversation renders as text,
 * tool, subagent and question cards.
 */
export type ActivityStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

interface ActivityEventBase {
  /** Stable within one turn. Harness ids win; deterministic generated ids fill gaps. */
  id: string;
  /**
   * The containing subagent's call/agent id. null means the parent turn.
   * Consumers resolve either a subagent `id` or its later-discovered `agentId`.
   */
  parentId: string | null;
  /** Harness timestamp, retained for duration/order without inventing a clock. */
  timestamp?: string | number | null;
}

export type ActivityEvent =
  | (ActivityEventBase & {
      kind: "text";
      text: string;
    })
  | (ActivityEventBase & {
      /**
       * A message Wisp steered into this turn, at the point in the transcript
       * where the harness accepted it. `id` is the message row's id, which
       * makes it idempotent across replays; `text` is only a one-line preview
       * — the row owns the full text and the delivery wording.
       */
      kind: "message";
      text: string;
    })
  | (ActivityEventBase & {
      kind: "thinking";
      /** null means the harness exposed a reasoning heartbeat but encrypted/omitted its text. */
      text: string | null;
    })
  | (ActivityEventBase & {
      kind: "tool";
      phase: "started" | "completed";
      name: string;
      input?: unknown;
      output?: string | null;
      error?: string | null;
    })
  | (ActivityEventBase & {
      kind: "subagent";
      phase: "started" | "updated" | "completed";
      status: ActivityStatus;
      /** Harness call id and child identity are deliberately separate. */
      agentId?: string | null;
      title?: string | null;
      agentType?: string | null;
      model?: string | null;
      effort?: string | null;
      prompt?: string | null;
      result?: string | null;
      error?: string | null;
      durationMs?: number | null;
      background?: boolean;
    })
  | (ActivityEventBase & {
      /**
       * The harness stopped to ask the operator a multiple-choice question.
       * Harness-neutral on purpose: Droid's AskUser and Claude's
       * AskUserQuestion pose the same shape, and the UI renders one card for
       * both. `id` is the tool call the answer resolves; the three phases
       * replay in log order.
       */
      kind: "question";
      phase: "asked" | "answered" | "cancelled";
      /** Why a cancelled question was released, which is what the card says. */
      reason?: "superseded" | "stopped";
      questions?: QuestionPrompt[];
      answers?: { index: number; answer: string }[];
    });

/** One question, as every harness that has this tool describes it. */
export interface QuestionPrompt {
  index: number;
  topic: string | null;
  question: string;
  multiSelect: boolean;
  /** 2–4 labels. An own-answer row is always offered on top of these. */
  options: string[];
}
