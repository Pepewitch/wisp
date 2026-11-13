import { claudeQuestions } from "../questionnaire";
import type { QuestionPrompt } from "../types";
import type { QuestionAnswer } from "./droid";

/**
 * Hands Claude's permission prompts to Wisp on stdout, as `control_request`
 * frames answered by a `control_response` on stdin. Live turns only: a turn
 * whose stdin closes after the prompt has nobody to answer.
 *
 * Live-verified on claude-code 2.1.322 (`-p`, stream-json in and out,
 * `--dangerously-skip-permissions`). Without this flag print mode does not
 * offer AskUserQuestion at all, and the model asks in prose. With it:
 *
 *  - AskUserQuestion is offered, and calling it sends
 *    `{type:"control_request", request_id, request:{subtype:"can_use_tool",
 *    tool_name:"AskUserQuestion", input, tool_use_id,
 *    requires_user_interaction:true}}`. Claude blocks until it is answered.
 *  - Bypass still covers every other tool: a Bash call in the same turn
 *    sent no request.
 *  - `{behavior:"allow", updatedInput:{...input, answers}}`, answers keyed by
 *    question text, comes back as the tool result "Your questions have been
 *    answered: …", with `tool_use_result.answers` holding the same map.
 *  - `{behavior:"deny", message}` comes back as an error result carrying
 *    the message, and lists the call in the result's `permission_denials`.
 */
export const CLAUDE_LIVE_ARGV = ["--permission-prompt-tool", "stdio"];

/** What a question released by a message tells the model, in place of an answer. */
const DEFERRED_ANSWER =
  "The person did not pick an option here. They replied with a message instead: follow the message that comes next.";
/** What a question released by a Stop tells the model. */
const STOPPED_ANSWER = "The person stopped the turn before answering.";

interface PendingClaudeQuestion {
  requestId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  questions: QuestionPrompt[];
}

type Settled = { phase: "answered" | "cancelled"; reason?: "superseded" | "stopped"; answers?: QuestionAnswer[] };

export interface ClaudeQuestionHooks {
  /** Write one line to Claude's stdin, in order with every other write. */
  write(frame: Record<string, unknown>): Promise<void>;
  /** Record a Wisp-authored event in the open turn's log. */
  emit(event: Record<string, unknown>): void;
  /** A question opened (true, with it) or the last one closed (false). */
  onWaiting(waiting: boolean, question?: { id: string; questions: QuestionPrompt[] }): void;
  /** One question settled: answered (on the card or by a message instead) or withdrawn. */
  onSettled(id: string, phase: "answered" | "cancelled"): void;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/**
 * The open questions of one live Claude process, by tool call id (the card's
 * id). Released with the write FIRST, as the Droid driver does: until Claude
 * has the reply nothing has changed for it, and clearing our state before a
 * failed write would leave Claude blocked with no card left to answer.
 */
export class ClaudeQuestions {
  private readonly pending = new Map<string, PendingClaudeQuestion>();

  constructor(private readonly hooks: ClaudeQuestionHooks) {}

  /**
   * Consume a control frame Claude sent. True when the frame was one of
   * these, whatever became of it. Any permission prompt other than a
   * question is allowed as asked: bypass already decided those, and a prompt
   * left unanswered would block the turn for good.
   */
  handle(frame: Record<string, unknown>): boolean {
    if (frame.type === "control_cancel_request") {
      const id = typeof frame.request_id === "string" ? frame.request_id : null;
      const pending = [...this.pending.values()].find((entry) => entry.requestId === id);
      if (pending) this.forget(pending, { phase: "cancelled", reason: "stopped" });
      return true;
    }
    if (frame.type !== "control_request") return false;
    const request = record(frame.request);
    if (request.subtype !== "can_use_tool" || typeof frame.request_id !== "string") return false;
    const input = record(request.input);
    const questions = request.tool_name === "AskUserQuestion" ? claudeQuestions(input) : [];
    const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : null;
    if (questions.length === 0 || !toolUseId) {
      void this.reply(frame.request_id, { behavior: "allow", updatedInput: input }).catch(() => {});
      return true;
    }
    this.pending.set(toolUseId, { requestId: frame.request_id, toolUseId, input, questions });
    this.hooks.onWaiting(true, { id: toolUseId, questions });
    // The tool call already drew the card; this is the record a reader of the
    // raw stream looks for, the same one the Droid driver writes.
    this.hooks.emit({ type: "question", phase: "asked", id: toolUseId, questions, timestamp: Date.now() });
    return true;
  }

  /** The question still waiting: the one named, else the oldest. */
  question(id?: string): { id: string; questions: QuestionPrompt[] } | null {
    const pending = id === undefined ? this.pending.values().next().value : this.pending.get(id);
    return pending ? { id: pending.toolUseId, questions: pending.questions } : null;
  }

  /** Answer one question from the card. Every question needs an answer, as on the card. */
  async answer(id: string, answers: QuestionAnswer[]): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("that question is no longer waiting for an answer");
    const byIndex = new Map(answers.map((entry) => [entry.index, entry.answer.trim()]));
    const resolved = pending.questions.map((question) => ({ question, answer: byIndex.get(question.index) ?? "" }));
    const missing = resolved.filter((entry) => !entry.answer).length;
    if (missing > 0) throw new Error(`answer every question first (${missing} still empty)`);
    // Keyed by Claude's own text: the card's copy may be truncated.
    const asked = Array.isArray(pending.input.questions) ? pending.input.questions.map(record) : [];
    const keyed = Object.fromEntries(resolved.map(({ question, answer }) => [
      typeof asked[question.index - 1]?.question === "string" ? asked[question.index - 1]!.question : question.question,
      answer,
    ]));
    await this.release(pending, { behavior: "allow", updatedInput: { ...pending.input, answers: keyed } }, {
      phase: "answered",
      answers: resolved.map(({ question, answer }) => ({ index: question.index, answer })),
    });
  }

  /**
   * A message went out while a question was open: that message is the
   * answer. Claude is blocked inside the tool, so the question is released
   * first or the message could never be read.
   */
  async deferToMessage(): Promise<void> {
    for (const pending of [...this.pending.values()]) {
      await this.release(pending, { behavior: "deny", message: DEFERRED_ANSWER }, { phase: "cancelled", reason: "superseded" });
    }
  }

  /** The turn is being stopped: release every question so nothing is left blocked. */
  async stop(): Promise<void> {
    for (const pending of [...this.pending.values()]) {
      await this.release(pending, { behavior: "deny", message: STOPPED_ANSWER }, { phase: "cancelled", reason: "stopped" })
        .catch(() => this.forget(pending, { phase: "cancelled", reason: "stopped" }));
    }
  }

  /** The process is gone: nothing can answer what is still open. */
  abandon(): void {
    for (const pending of [...this.pending.values()]) this.forget(pending, { phase: "cancelled", reason: "stopped" });
  }

  private reply(requestId: string, response: Record<string, unknown>): Promise<void> {
    return this.hooks.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  private async release(pending: PendingClaudeQuestion, response: Record<string, unknown>, settled: Settled): Promise<void> {
    await this.reply(pending.requestId, response);
    this.forget(pending, settled);
  }

  private forget(pending: PendingClaudeQuestion, settled: Settled): void {
    if (!this.pending.delete(pending.toolUseId)) return;
    // a message sent instead is the answer too
    this.hooks.onSettled(pending.toolUseId, settled.phase === "answered" || settled.reason === "superseded" ? "answered" : "cancelled");
    if (this.pending.size === 0 && settled.reason !== "stopped") this.hooks.onWaiting(false);
    this.hooks.emit({ type: "question", id: pending.toolUseId, timestamp: Date.now(), ...settled });
  }
}
