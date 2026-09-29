/**
 * `GET /api/search?q=…` — exact text across this daemon's live tasks.
 *
 * The scope, the caps and the one case-folding gap belong to store-search.ts;
 * this file is only the contract at the edge, plus the one fact the store does
 * not own: whether the prose index has caught up. An empty `q` is a 400 rather
 * than "every task", because a search box that answers a blank query with the
 * whole ledger has answered a question nobody asked.
 *
 * The scan itself runs off the request thread (search-runner.ts). When the
 * client gives up on a request — the sidebar does, each time the query changes
 * — the search it asked for is dropped or stopped.
 */
import { runSearch, SearchUnavailable } from "../search-runner";
import { SEARCH_QUERY_MAX_CHARS } from "../store-search";
import { turnTextIndexStatus } from "../turn-text-backfill";
import type { SearchResponse } from "../types";
import { err, json } from "./http";

export function searchRoute(req: Request, url: URL, method: string): Promise<Response> | Response | null {
  if (url.pathname !== "/api/search") return null;
  if (method !== "GET") return err("method not allowed", 405);
  const raw = url.searchParams.get("q");
  if (raw === null) return err("q is required", 400);
  // Trimmed, not rejected: a trailing space is a keystroke on the way to the
  // next word, and answering it with zero results reads as a broken search.
  const query = raw.trim();
  if (query === "") return err("q must not be empty", 400);
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    return err(`q must be at most ${SEARCH_QUERY_MAX_CHARS} characters, got ${query.length}`, 400);
  }
  return answer(query, req.signal);
}

async function answer(query: string, signal: AbortSignal): Promise<Response> {
  let found: SearchResponse;
  try {
    found = await runSearch(query, signal);
  } catch (error) {
    if (error instanceof SearchUnavailable) return err(error.message, error.status);
    throw error;
  }
  // Two facts, one answer: what matched, and whether the agent-prose index has
  // finished catching up on turns older than it (turn-text-backfill.ts).
  const remainingTurns = turnTextIndexStatus().remaining;
  return json({
    ...found,
    ...(remainingTurns > 0 ? { indexing: { remainingTurns } } : {}),
  });
}
