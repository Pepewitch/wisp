import type { AdapterDef } from "../adapters";
import { totalUsage } from "../adapters/usage";
import {
  latestTurnForTask,
  messagesFor,
  messagesForTurnPage,
  turnPageFor,
  turnsFor,
  turnUsageFor,
} from "../store";
import type { Task } from "../types";
import {
  apiTask,
  apiTaskMessage,
  apiTurn,
  apiTurnUsage,
  err,
  integerQueryParam,
  json,
} from "./http";

const MAX_CONVERSATION_PAGE_SIZE = 100;
const TASK_USAGE_DETAIL_LIMIT = 50;

/** The unpaginated protocol-1 compatibility payload. */
export function conversationDetail(task: Task, adapters: Record<string, AdapterDef>): Record<string, unknown> {
  const turns = turnsFor(task.id);
  const latest = turns.at(-1);
  return {
    ...apiTask(task),
    latest_turn_model: latest?.model ?? null,
    latest_turn_exit_code: latest?.exit_code ?? null,
    latest_turn_has_result: latest ? latest.result !== null : false,
    turns: turns.map((turn) => apiTurn(turn, adapters[turn.harness])),
    messages: messagesFor(task.id).map(apiTaskMessage),
  };
}

function pagedConversationDetail(
  task: Task,
  adapters: Record<string, AdapterDef>,
  before: number | null,
  limit: number,
): Record<string, unknown> {
  const page = turnPageFor(task.id, before, limit);
  const latest = latestTurnForTask(task.id);
  const first = page.turns.at(0)?.n ?? null;
  const last = page.turns.at(-1)?.n ?? null;
  return {
    ...apiTask(task),
    latest_turn_model: latest?.model ?? null,
    latest_turn_exit_code: latest?.exit_code ?? null,
    latest_turn_has_result: latest ? latest.result !== null : false,
    turns: page.turns.map((turn) => apiTurn(turn, adapters[turn.harness])),
    messages: messagesForTurnPage(task.id, first, last, before === null).map(apiTaskMessage),
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
  let detail: Record<string, unknown>;
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
  const response = json(detail);
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
  return json({
    total: totalUsage(turns.map((turn) => turn.usage)),
    reporting_turns: turns.length,
    turns: turns.slice(-TASK_USAGE_DETAIL_LIMIT),
    has_older_turns: turns.length > TASK_USAGE_DETAIL_LIMIT,
  });
}
