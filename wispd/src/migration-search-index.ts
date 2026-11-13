/**
 * Migration 34, kept beside the ledger (migrations.ts) because that file is
 * at its size limit; it is listed there in order like every other step.
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations";

/**
 * Whether this SQLite has FTS5 with the trigram tokenizer (3.34+). Bun links
 * its own SQLite on Linux, but on macOS it loads the system one, so an older
 * macOS could lack it; search then keeps scanning (store-search.ts).
 */
export function trigramAvailable(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.trigram_probe USING fts5(text, tokenize = 'trigram')");
    db.exec("DROP TABLE temp.trigram_probe");
    return true;
  } catch {
    return false;
  }
}

/**
 * Trigram indexes for search's two expensive sources: a turn's prompt and
 * result, and the agent's prose between its tool calls. Search scanned both
 * with `LIKE '%x%'` on every query, which no ordinary index can serve: 33–59
 * ms on a real home, growing with history. A trigram index answers "which
 * rows might contain this substring" for any query of three or more
 * characters; store-search.ts still applies the LIKE to the rows it names,
 * so results do not change, only how many rows are read.
 *
 * Both keep no positions (`detail=none`): for each trigram, only which rows
 * hold it. That is about 0.7 times the text it covers, where positions made
 * it nearly 4 times; search asks for every trigram of the needle and lets
 * LIKE do the rest. Both are external-content tables, storing none of the
 * text, which makes the triggers load-bearing: an FTS5 'delete' must be
 * given the values that were indexed. That holds
 * because every write to an indexed column goes through these triggers; a
 * migration that rebuilds `turns` or `turn_texts` must drop and recreate
 * them (and 'rebuild' the index) too. Each is keyed by a stable integer:
 * turns by `id`, prose by `turn_id` through a view, never by an implicit
 * rowid, which a VACUUM may renumber.
 *
 * Task titles and queued messages stay scanned: they are short and few, and
 * their scans cost under a millisecond where these cost tens.
 */
export const SEARCH_INDEX: Migration = {
  id: 34,
  name: "search-index",
  up: (db) => {
    if (!trigramAvailable(db)) return;
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS search_turns USING fts5(
  prompt, result, content = 'turns', content_rowid = 'id', tokenize = 'trigram', detail = 'none'
);
INSERT INTO search_turns(search_turns) VALUES ('rebuild');
CREATE TRIGGER IF NOT EXISTS search_turns_insert AFTER INSERT ON turns BEGIN
  INSERT INTO search_turns(rowid, prompt, result) VALUES (new.id, new.prompt, new.result);
END;
CREATE TRIGGER IF NOT EXISTS search_turns_delete AFTER DELETE ON turns BEGIN
  INSERT INTO search_turns(search_turns, rowid, prompt, result) VALUES ('delete', old.id, old.prompt, old.result);
END;
CREATE TRIGGER IF NOT EXISTS search_turns_update AFTER UPDATE OF id, prompt, result ON turns BEGIN
  INSERT INTO search_turns(search_turns, rowid, prompt, result) VALUES ('delete', old.id, old.prompt, old.result);
  INSERT INTO search_turns(rowid, prompt, result) VALUES (new.id, new.prompt, new.result);
END;

CREATE VIEW IF NOT EXISTS search_prose_rows AS SELECT turn_id, text FROM turn_texts WHERE kind = 'prose';
CREATE VIRTUAL TABLE IF NOT EXISTS search_prose USING fts5(
  text, content = 'search_prose_rows', content_rowid = 'turn_id', tokenize = 'trigram', detail = 'none'
);
INSERT INTO search_prose(search_prose) VALUES ('rebuild');
CREATE TRIGGER IF NOT EXISTS search_prose_insert AFTER INSERT ON turn_texts WHEN new.kind = 'prose' BEGIN
  INSERT INTO search_prose(rowid, text) VALUES (new.turn_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS search_prose_delete AFTER DELETE ON turn_texts WHEN old.kind = 'prose' BEGIN
  INSERT INTO search_prose(search_prose, rowid, text) VALUES ('delete', old.turn_id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS search_prose_update AFTER UPDATE OF turn_id, kind, text ON turn_texts BEGIN
  INSERT INTO search_prose(search_prose, rowid, text) SELECT 'delete', old.turn_id, old.text WHERE old.kind = 'prose';
  INSERT INTO search_prose(rowid, text) SELECT new.turn_id, new.text WHERE new.kind = 'prose';
END;
`);
  },
};
