/**
 * The agent's prose, indexed so search can reach it.
 *
 * A turn's durable columns hold what the person asked (`turns.prompt`) and how
 * the agent CONCLUDED (`turns.result`). Everything the agent said in between —
 * the paragraphs that explain the next tool call — lives only in the turn's
 * JSONL, which caps at 5 MB and is the evidence ledger rather than an index.
 * Scanning those files per keystroke is not a search, it is a disk sweep, so
 * the prose is projected ONCE, when the turn ends, into `turn_texts`.
 *
 * Three properties make this safe to rely on:
 *
 * - **Derived, never authoritative.** The log stays the record; a row here can
 *   be deleted and rebuilt from it. That is why the migration backfills
 *   nothing: the daemon does it in the background, resumably, after it is
 *   listening (turn-text-backfill.ts).
 * - **No new parser.** The lines go through the adapter's own
 *   `createActivityFormatter`, the one place harness wire shapes are allowed,
 *   and only `kind: "text"` events are kept. A harness Wisp cannot structure
 *   contributes nothing rather than leaked JSON.
 * - **Honest about what it holds.** `state` is `complete`, `partial` (the
 *   64 KB cap cut it) or `unavailable` (the log could not be read). Search
 *   never presents a partial index as a whole one.
 *
 * `thinking` and `tool` are deliberately NOT indexed yet. They are the same
 * table with another `kind` when they are asked for, which is what keeps that
 * decision additive instead of a rewrite.
 */
import { readFile } from "node:fs/promises";

import { createActivityFormatter, type AdapterDef } from "./adapters";
import { db } from "./store-database";

/** The only kind indexed today: the agent's own prose. */
export const TURN_TEXT_PROSE = "prose";

/**
 * Per turn, per kind. Prose is a fraction of a JSONL log (tool output
 * dominates), so 64 KB is generous for the text and still bounded: measured at
 * ~2 KB/turn across a synthetic 18 000-turn ledger, 38 MB of index in total.
 */
export const MAX_TURN_TEXT_BYTES = 64 * 1024;

export type TurnTextState = "complete" | "partial" | "unavailable";

export interface TurnTextRow {
  turn_id: number;
  kind: string;
  task_id: string;
  text: string;
  bytes: number;
  state: TurnTextState;
  indexed_at: string;
}

export interface ExtractedTurnText {
  text: string;
  state: TurnTextState;
}

/**
 * Project one turn's JSONL into its prose.
 *
 * `conclusion` is `turns.result`, which search already covers, so prose that
 * merely repeats it is dropped: a hit must not be counted twice, and the
 * concluding paragraph is the one every harness repeats at the end.
 */
export function extractTurnProse(
  def: AdapterDef | undefined,
  jsonl: string,
  conclusion: string | null,
): ExtractedTurnText {
  const format = createActivityFormatter(def);
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    for (const event of format(line)) {
      if (event.kind !== "text") continue;
      const text = event.text.trim();
      if (text === "") continue;
      if (conclusion !== null && conclusion.includes(text)) continue;
      const size = Buffer.byteLength(text, "utf8") + 1;
      if (bytes + size > MAX_TURN_TEXT_BYTES) {
        partial = true;
        continue;
      }
      bytes += size;
      kept.push(text);
    }
  }
  return { text: kept.join("\n"), state: partial ? "partial" : "complete" };
}

/** Read a settled turn's log. An unreadable log is a state, not a throw. */
async function readLog(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function putTurnText(row: Omit<TurnTextRow, "indexed_at">): void {
  db.run(
    `INSERT INTO turn_texts (turn_id, kind, task_id, text, bytes, state, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id, kind) DO UPDATE SET
       text = excluded.text, bytes = excluded.bytes, state = excluded.state, indexed_at = excluded.indexed_at`,
    [row.turn_id, row.kind, row.task_id, row.text, row.bytes, row.state, new Date().toISOString()],
  );
}

export function getTurnText(turnId: number, kind = TURN_TEXT_PROSE): TurnTextRow | null {
  return (
    (db.query(`SELECT * FROM turn_texts WHERE turn_id = ? AND kind = ?`).get(turnId, kind) as TurnTextRow | null) ??
    null
  );
}

/**
 * Index one settled turn. Always writes a row — an unreadable log records
 * `unavailable` rather than nothing, because "not indexed yet" and "there is
 * nothing to index" are different facts and the backfill has to tell them
 * apart or it would retry a lost log forever.
 */
export async function indexTurnProse(input: {
  turnId: number;
  taskId: string;
  logFile: string;
  result: string | null;
  def: AdapterDef | undefined;
}): Promise<TurnTextState> {
  const jsonl = await readLog(input.logFile);
  const extracted: ExtractedTurnText =
    jsonl === null ? { text: "", state: "unavailable" } : extractTurnProse(input.def, jsonl, input.result);
  putTurnText({
    turn_id: input.turnId,
    kind: TURN_TEXT_PROSE,
    task_id: input.taskId,
    text: extracted.text,
    bytes: Buffer.byteLength(extracted.text, "utf8"),
    state: extracted.state,
  });
  return extracted.state;
}
