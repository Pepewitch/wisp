import { api, CliApiError, daemonRequest, exitApi } from "./cli-api";
import { print, printError } from "./cli-print";
import type { ApiTurn, ConversationDetail, TaskDetail } from "../../shared/api/task";

/** Most results are in the newest turn, so the first page is small; the rest are as large as the route allows. */
const FIRST_PAGE = 10;
const OLDER_PAGE = 100;

/**
 * One page of the conversation, newest turns last, or null from a daemon
 * without the paged route (its 404 is not "no such task"). A daemon that
 * ignores `limit` answers every turn at once, which the callers read the same.
 */
async function conversationPage(id: string, before: number | null, limit: number): Promise<ConversationDetail | null> {
  try {
    return (await daemonRequest(`/api/tasks/${id}/conversation?limit=${limit}${before === null ? "" : `&before=${before}`}`)) as ConversationDetail;
  } catch (error) {
    if (error instanceof CliApiError && error.status === 404 && !error.message.startsWith("no such task")) return null;
    exitApi(error);
  }
}

/** The turn `wisp result` prints: turn `n`, else the newest with a result, else the newest. */
function pick(turns: ApiTurn[], n: number | undefined): ApiTurn | undefined {
  return n
    ? turns.find((candidate) => candidate.n === n)
    : [...turns].reverse().find((candidate) => candidate.result) ?? turns[turns.length - 1];
}

/**
 * Pages back from the newest turn until the one to print is in hand. It used
 * to read the full task detail, every turn and message plus a git health
 * check and diffstat (5.5 MB on a 1,341-turn task), for one turn's text.
 */
async function resultTurn(id: string, n: number | undefined): Promise<ApiTurn | undefined> {
  // not a turn number any page could answer: the old read's answer, from the old read
  if (n !== undefined && !(Number.isInteger(n) && n > 0)) return pick(((await api(`/api/tasks/${id}`)) as TaskDetail).turns, n);
  let before = n === undefined ? null : n + 1;
  let limit = n === undefined ? FIRST_PAGE : 1;
  let newest: ApiTurn | undefined;
  for (;;) {
    const page = await conversationPage(id, before, limit);
    if (page === null) return pick(((await api(`/api/tasks/${id}`)) as TaskDetail).turns, n);
    if (n !== undefined) return pick(page.turns, n);
    newest ??= page.turns.at(-1);
    const answered = [...page.turns].reverse().find((candidate) => candidate.result);
    if (answered) return answered;
    if (!page.has_older_turns || page.older_turns_before == null) return newest;
    before = page.older_turns_before;
    limit = OLDER_PAGE;
  }
}

/** `wisp result <task> [turn]`: one turn's prompt and the agent's full answer. */
export async function resultCommand(positional: string[]): Promise<void> {
  const n = positional[1] ? Number(positional[1]) : undefined;
  const turn = await resultTurn(positional[0]!, n || undefined);
  if (!turn) {
    printError("no turns yet");
    process.exit(1);
  }
  print(`── you (turn ${turn.n}) ──\n${turn.prompt}\n── agent ──`);
  if (turn.result) {
    print(turn.result);
    // a turn can fail after its result landed (the harness exited nonzero)
    if (turn.failure_detail) print(`── failed ──\n${turn.failure_detail}`);
  } else if (turn.failure_detail) print(`(turn ${turn.n} failed, no result text: ${turn.failure_detail})`);
  else print(`(turn ${turn.n} is ${turn.status}, no result text)`);
}
