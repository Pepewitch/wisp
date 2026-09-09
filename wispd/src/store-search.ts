/**
 * Exact-text search across a daemon's LIVE tasks (non-archived).
 *
 * Scope is deliberate and it is what the UI promises: the four places a
 * person's or an agent's WORDS are durable columns — a task title, a turn's
 * prompt, a turn's concluding result, and a queued or steered message. The
 * per-turn JSONL transcripts under ~/.wisp/logs are NOT searched: they cap at
 * 5 MB per turn, they are the evidence ledger rather than an index, and
 * scanning them would turn a keystroke into a disk sweep. A search that lied
 * about its scope would be worse than one that states it, so the client says
 * so out loud.
 *
 * Matching is literal substring, case-insensitive. SQL narrows with LIKE
 * (ASCII-insensitive) and JS confirms and locates with toLowerCase(), so the
 * one gap is non-ASCII case folding: searching "CAFÉ" does not find "café",
 * because LIKE never offered the row. Add SQLite's ICU extension before
 * promising otherwise — the daemon ships zero runtime dependencies (D10).
 */
import { db } from "./store-database";

export type SearchSnippetKind = "title" | "prompt" | "result" | "message";

export interface SearchSnippet {
  kind: SearchSnippetKind;
  /** the turn a prompt/result snippet came from; null for a title or a message */
  turn: number | null;
  /** one collapsed line around the first match, ellipsised at either end */
  text: string;
  /** where the match sits inside `text`, so the client highlights bytes it was given */
  offset: number;
  length: number;
}

export interface SearchTaskHit {
  id: string;
  title: string;
  repo_path: string;
  updated_at: string;
  /** total occurrences across every searched field of this task */
  matches: number;
  snippets: SearchSnippet[];
}

export interface SearchResult {
  query: string;
  tasks: SearchTaskHit[];
  /** a scan cap was reached, so this answer is not the whole ledger */
  truncated: boolean;
}

/** One sidebar's worth of results. More than this is a different question. */
export const SEARCH_TASK_LIMIT = 60;
/** Enough to say WHERE it matched without turning a row into a paragraph. */
export const SEARCH_SNIPPETS_PER_TASK = 3;
/** Per-source row cap. A hit past this is reported as truncation, never dropped silently. */
export const SEARCH_ROW_LIMIT = 4000;
export const SEARCH_QUERY_MAX_CHARS = 200;

const WINDOW_BEFORE = 32;
const WINDOW_AFTER = 96;

/** `%`, `_` and the escape itself are literals in a person's search box. */
export function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/** Every occurrence, case-insensitively, without allocating a match array. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * One display line around a match. The window is cut from the ORIGINAL text so
 * the offset is exact, then each side is whitespace-collapsed separately and
 * the offset recomputed — collapsing first would let a newline inside the
 * needle change what "exact" means.
 */
export function buildSnippet(
  kind: SearchSnippetKind,
  turn: number | null,
  text: string,
  at: number,
  length: number,
): SearchSnippet {
  const from = Math.max(0, at - WINDOW_BEFORE);
  const to = Math.min(text.length, at + length + WINDOW_AFTER);
  const lead = (from > 0 ? "…" : "") + collapse(text.slice(from, at)).trimStart();
  const match = collapse(text.slice(at, at + length));
  const tail = collapse(text.slice(at + length, to)).trimEnd() + (to < text.length ? "…" : "");
  return { kind, turn, text: `${lead}${match}${tail}`, offset: lead.length, length: match.length };
}

class Hits {
  private readonly byTask = new Map<string, SearchTaskHit>();

  constructor(private readonly needle: string) {}

  /** Records a field's occurrences, keeping at most one snippet per field. */
  add(
    task: { id: string; title: string; repo_path: string; updated_at: string },
    kind: SearchSnippetKind,
    turn: number | null,
    text: string | null,
  ): void {
    if (text === null || text === "") return;
    const at = text.toLowerCase().indexOf(this.needle);
    if (at === -1) return;
    let hit = this.byTask.get(task.id);
    if (!hit) {
      hit = {
        id: task.id,
        title: task.title,
        repo_path: task.repo_path,
        updated_at: task.updated_at,
        matches: 0,
        snippets: [],
      };
      this.byTask.set(task.id, hit);
    }
    hit.matches += countOccurrences(text.toLowerCase(), this.needle);
    if (hit.snippets.length < SEARCH_SNIPPETS_PER_TASK) {
      hit.snippets.push(buildSnippet(kind, turn, text, at, this.needle.length));
    }
  }

  /** Newest task first — the sidebar's own order, so results read like the tree. */
  tasks(): SearchTaskHit[] {
    return [...this.byTask.values()]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, SEARCH_TASK_LIMIT);
  }
}

interface TaskColumns {
  id: string;
  title: string;
  repo_path: string;
  updated_at: string;
}

export function searchTasks(query: string): SearchResult {
  const needle = query.toLowerCase();
  const like = `%${escapeLike(query)}%`;
  const hits = new Hits(needle);
  let truncated = false;

  const titles = db
    .query(
      `SELECT id, title, repo_path, updated_at FROM tasks
       WHERE archived = 0 AND title LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(like, SEARCH_ROW_LIMIT) as TaskColumns[];
  truncated ||= titles.length === SEARCH_ROW_LIMIT;
  for (const row of titles) hits.add(row, "title", null, row.title);

  const turns = db
    .query(
      `SELECT t.id, t.title, t.repo_path, t.updated_at, n.n, n.prompt, n.result
       FROM turns n JOIN tasks t ON t.id = n.task_id
       WHERE t.archived = 0 AND (n.prompt LIKE ? ESCAPE '\\' OR n.result LIKE ? ESCAPE '\\')
       ORDER BY t.updated_at DESC, n.n DESC LIMIT ?`,
    )
    .all(like, like, SEARCH_ROW_LIMIT) as (TaskColumns & { n: number; prompt: string; result: string | null })[];
  truncated ||= turns.length === SEARCH_ROW_LIMIT;
  for (const row of turns) {
    hits.add(row, "prompt", row.n, row.prompt);
    hits.add(row, "result", row.n, row.result);
  }

  // A message whose delivery is 'started' BECAME its turn's prompt, so it is
  // already searched above; counting it twice would inflate the total.
  const messages = db
    .query(
      `SELECT t.id, t.title, t.repo_path, t.updated_at, m.text
       FROM task_messages m JOIN tasks t ON t.id = m.task_id
       WHERE t.archived = 0 AND (m.delivery IS NULL OR m.delivery <> 'started')
         AND m.text LIKE ? ESCAPE '\\'
       ORDER BY t.updated_at DESC, m.created_at DESC LIMIT ?`,
    )
    .all(like, SEARCH_ROW_LIMIT) as (TaskColumns & { text: string })[];
  truncated ||= messages.length === SEARCH_ROW_LIMIT;
  for (const row of messages) hits.add(row, "message", null, row.text);

  const tasks = hits.tasks();
  return { query, tasks, truncated: truncated || tasks.length === SEARCH_TASK_LIMIT };
}
