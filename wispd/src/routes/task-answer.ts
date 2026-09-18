import { activeLiveInput } from "../live-input";
import { assertTaskNotStopping, InterruptConflict } from "../turn-interrupt";
import type { Task } from "../types";
import { err, json, jsonObjectBody } from "./http";

/** One answer's ceiling. Four questions of prose is not an answer, it is a prompt. */
const ANSWER_MAX = 2_000;

/**
 * Answer a questionnaire the harness is blocked on, in its own protocol, so
 * the turn resumes where it paused instead of ending and being re-primed.
 *
 * 409 is the honest answer whenever that channel is gone — a turn that ended,
 * a daemon that restarted, a harness with no reply path. The card then shows
 * itself as expired and the operator answers by sending, which is the same
 * thing every harness without this tool already does.
 */
export function answerQuestionResponse(task: Task, req: Request): Promise<Response> {
  return (async () => {
    if (task.archived) return err("task is archived — archived tasks are read-only", 409);
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const body = parsed as { questionId?: unknown; answers?: unknown };
    if (typeof body.questionId !== "string" || !body.questionId) {
      return err("questionId is required", 400);
    }
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      return err("answers is required", 400);
    }
    const answers: { index: number; answer: string }[] = [];
    for (const entry of body.answers) {
      const row = entry as { index?: unknown; answer?: unknown };
      if (typeof row.index !== "number" || !Number.isFinite(row.index)) {
        return err("every answer needs a numeric index", 400);
      }
      if (typeof row.answer !== "string") return err("every answer needs answer text", 400);
      answers.push({ index: row.index, answer: row.answer.slice(0, ANSWER_MAX) });
    }
    // An answer is a write into a live turn, the same as a steer, so it owes
    // the same refusal while that turn is being stopped.
    try {
      assertTaskNotStopping(task.id);
    } catch (error) {
      if (error instanceof InterruptConflict) return err(error.message, 409);
      throw error;
    }
    const live = activeLiveInput(task.id);
    if (!live?.answer) {
      return err("this question is no longer waiting for an answer — send it as a message instead", 409);
    }
    try {
      // The driver owns the state move back to running: it is the half that
      // knows the harness actually took the answer.
      await live.answer(body.questionId, answers);
    } catch (error) {
      return err(String(error instanceof Error ? error.message : error), 409);
    }
    return json({ ok: true });
  })();
}
