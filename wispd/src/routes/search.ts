/**
 * `GET /api/search?q=…` — exact text across this daemon's live tasks.
 *
 * The scope, the caps and the one case-folding gap belong to store-search.ts;
 * this file is only the contract at the edge. An empty `q` is a 400 rather
 * than "every task", because a search box that answers a blank query with the
 * whole ledger has answered a question nobody asked.
 */
import { searchTasks, SEARCH_QUERY_MAX_CHARS } from "../store-search";
import { err, json } from "./http";

export function searchRoute(url: URL, method: string): Response | null {
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
  return json(searchTasks(query));
}
