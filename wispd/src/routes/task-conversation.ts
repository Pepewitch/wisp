import type { AdapterDef } from "../adapters";
import { totalUsage } from "../adapters/usage";
import { activeLiveInput } from "../live-input";
import {
  latestTurnForTask,
  messagesFor,
  messagesForTurnPage,
  turnPageFor,
  turnsFor,
  turnUsageFor,
} from "../store";
import type { Task, TaskMessage, Turn } from "../types";
import type { ConversationDetail, TaskUsage } from "../../../shared/api/task";
import {
  apiTask,
  apiTaskMessage,
  apiTurn,
  apiTurnUsage,
  err,
  turnSource,
  integerQueryParam,
  json,
} from "./http";

/**
 * The ONE question the harness is actually blocked on, if any.
 *
 * A transcript can hold several unreleased questions — an older Droid's
 * fallback leaves one `asked` in the log with nothing to answer it — and the
 * log cannot tell them apart, because "still open" and "open in this daemon,
 * right now" are different facts. Only the live driver knows the second one,
 * so the card asks it by id rather than inferring from the task's state.
 */
function pendingQuestionId(task: Task): string | null {
  return activeLiveInput(task.id)?.question?.()?.id ?? null;
}

const MAX_CONVERSATION_PAGE_SIZE = 100;

/** The turns as served, each with its source read from the response's own messages. */
function apiTurns(turns: Turn[], messages: TaskMessage[], adapters: Record<string, AdapterDef>) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return turns.map((turn) => apiTurn(turn, adapters[turn.harness], turnSource(turn, byId)));
}
const TASK_USAGE_DETAIL_LIMIT = 50;

/** The unpaginated protocol-1 compatibility payload. */
export function conversationDetail(task: Task, adapters: Record<string, AdapterDef>): ConversationDetail {
  const turns = turnsFor(task.id);
  const messages = messagesFor(task.id);
  const latest = turns.at(-1);
  return {
    ...apiTask(task),
    latest_turn_model: latest?.model ?? null,
    latest_turn_exit_code: latest?.exit_code ?? null,
    latest_turn_has_result: latest ? latest.result !== null : false,
    turns: apiTurns(turns, messages, adapters),
    messages: messages.map(apiTaskMessage),
    pending_question_id: pendingQuestionId(task),
  };
}

function pagedConversationDetail(
  task: Task,
  adapters: Record<string, AdapterDef>,
  before: number | null,
  limit: number,
): ConversationDetail {
  const page = turnPageFor(task.id, before, limit);
  const latest = latestTurnForTask(task.id);
  const first = page.turns.at(0)?.n ?? null;
  const last = page.turns.at(-1)?.n ?? null;
  const messages = messagesForTurnPage(task.id, first, last, before === null);
  return {
    ...apiTask(task),
    latest_turn_model: latest?.model ?? null,
    latest_turn_exit_code: latest?.exit_code ?? null,
    latest_turn_has_result: latest ? latest.result !== null : false,
    turns: apiTurns(page.turns, messages, adapters),
    messages: messages.map(apiTaskMessage),
    pending_question_id: pendingQuestionId(task),
    has_older_turns: page.hasOlder,
    older_turns_before: page.hasOlder ? first : null,
  };
}

/**
 * GET /api/tasks/:id/conversation — SQLite-only history. Pagination is opt-in
 * so older protocol-1 clients retain their full-history response.
 */
export function conversationResponse(
  task: Task,
  url: URL,
  adapters: Record<string, AdapterDef>,
): Response {
  const started = performance.now();
  const limitParam = url.searchParams.get("limit");
  let detail: ConversationDetail;
  if (limitParam === null) {
    detail = conversationDetail(task, adapters);
  } else {
    const limit = integerQueryParam(url, "limit", 1);
    if (limit instanceof Response) return limit;
    if (limit! > MAX_CONVERSATION_PAGE_SIZE) {
      return err(`limit must be at most ${MAX_CONVERSATION_PAGE_SIZE}`, 400);
    }
    const before = integerQueryParam(url, "before", 1);
    if (before instanceof Response) return before;
    detail = pagedConversationDetail(task, adapters, before, limit!);
  }
  const response = json<ConversationDetail>(detail);
  response.headers.set("server-timing", `conversation;dur=${(performance.now() - started).toFixed(1)}`);
  return response;
}

/** GET /api/tasks/:id/usage — bounded detail plus exact task-wide totals. */
export function taskUsageResponse(task: Task, adapters: Record<string, AdapterDef>): Response {
  const turns = turnUsageFor(task.id)
    .flatMap((turn) => {
      const usage = apiTurnUsage(turn.usage_json, adapters[turn.harness]);
      return usage ? [{ id: turn.id, n: turn.n, usage }] : [];
    });
  return json<TaskUsage>({
    total: totalUsage(turns.map((turn) => turn.usage)),
    reporting_turns: turns.length,
    turns: turns.slice(-TASK_USAGE_DETAIL_LIMIT),
    has_older_turns: turns.length > TASK_USAGE_DETAIL_LIMIT,
  });
}
