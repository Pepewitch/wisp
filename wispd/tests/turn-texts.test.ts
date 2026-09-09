import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILTIN_ADAPTERS } from "../src/adapters";
import { db } from "../src/store-database";
import {
  createTask,
  createTurn,
  finishTurn,
  freeSlot,
  newTaskId,
  setTaskFields,
} from "../src/store";
import { searchTasks } from "../src/store-search";
import { finalizeTurn } from "../src/turn-finalize";
import { purgeTask } from "../src/task-retention";
import { getTask } from "../src/store";
import {
  backfillTurnTexts,
  countPendingProseTurns,
  pendingProseTurns,
  turnTextIndexStatus,
} from "../src/turn-text-backfill";
import {
  extractTurnProse,
  getTurnText,
  indexTurnProse,
  MAX_TURN_TEXT_BYTES,
} from "../src/turn-texts";
import { fixture } from "./fixtures";

/**
 * The agent-prose index: what it extracts, what it refuses to duplicate, what
 * it admits it could not read, and the background pass that catches up on
 * turns older than the feature.
 */

const logs: string[] = [];

function logDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisp-prose-"));
  logs.push(dir);
  return dir;
}

afterEach(() => {
  while (logs.length) rmSync(logs.pop()!, { recursive: true, force: true });
});

/** A claude-shaped assistant message. The adapter owns the wire shape; a test
 * that needs three paragraphs of prose has to write them somewhere. */
function claudeText(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function task(title = "prose task"): string {
  const id = newTaskId();
  createTask({ id, title, repo_path: "/tmp/repo", harness: "claude", model: null, slot: freeSlot() });
  return id;
}

function settledTurn(taskId: string, n: number, jsonl: string, result: string | null): { id: number; path: string } {
  const path = join(logDir(), `${taskId}-turn${n}.out.log`);
  writeFileSync(path, jsonl);
  const id = createTurn(taskId, n, `prompt ${n}`, null, path);
  finishTurn(id, "done", 0, result);
  return { id, path };
}

describe("extractTurnProse", () => {
  test("keeps the agent's prose out of a real recorded log, and nothing else", () => {
    const prose = extractTurnProse(BUILTIN_ADAPTERS.claude, fixture("claude-subagent.jsonl"), null);

    expect(prose.state).toBe("complete");
    expect(prose.text).toBe("wisp");
    // tool calls and their output are not prose and are not indexed (yet)
    expect(prose.text).not.toContain("tool_use");
    expect(prose.text).not.toContain("Bash");
  });

  test("reads codex's own agent_message shape through its own normalizer", () => {
    const prose = extractTurnProse(BUILTIN_ADAPTERS.codex, fixture("codex-first-turn.jsonl"), null);
    expect(prose.text).toBe("papaya");
  });

  test("drops prose the turn's result already carries, so a hit is counted once", () => {
    const jsonl = [claudeText("thinking about the reducer"), claudeText("Done: the reducer keeps its tail")].join("\n");

    const both = extractTurnProse(BUILTIN_ADAPTERS.claude, jsonl, null);
    expect(both.text.split("\n")).toHaveLength(2);

    const deduped = extractTurnProse(BUILTIN_ADAPTERS.claude, jsonl, "Done: the reducer keeps its tail");
    expect(deduped.text).toBe("thinking about the reducer");
  });

  test("caps a chatty turn and says the index is partial", () => {
    const paragraph = "x".repeat(4096);
    const jsonl = Array.from({ length: 40 }, (_, index) => claudeText(`${index} ${paragraph}`)).join("\n");

    const prose = extractTurnProse(BUILTIN_ADAPTERS.claude, jsonl, null);

    expect(prose.state).toBe("partial");
    expect(Buffer.byteLength(prose.text, "utf8")).toBeLessThanOrEqual(MAX_TURN_TEXT_BYTES);
  });

  test("an unstructured harness contributes nothing rather than leaking JSON", () => {
    // no `activity` normalizer: the projection degrades to prose it can trust
    const prose = extractTurnProse(undefined, claudeText("hello"), null);
    expect(prose.text).not.toContain('"type"');
  });
});

describe("indexTurnProse", () => {
  test("writes one row per turn, and re-indexing replaces it", async () => {
    const id = task();
    const turn = settledTurn(id, 1, claudeText("first pass over the reducer"), null);

    await indexTurnProse({ turnId: turn.id, taskId: id, logFile: turn.path, result: null, def: BUILTIN_ADAPTERS.claude });
    expect(getTurnText(turn.id)?.text).toBe("first pass over the reducer");

    writeFileSync(turn.path, claudeText("second pass over the reducer"));
    await indexTurnProse({ turnId: turn.id, taskId: id, logFile: turn.path, result: null, def: BUILTIN_ADAPTERS.claude });

    expect(getTurnText(turn.id)?.text).toBe("second pass over the reducer");
    const rows = db.query(`SELECT COUNT(*) AS n FROM turn_texts WHERE turn_id = ?`).get(turn.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  test("records an unreadable log as unavailable, never as empty prose", async () => {
    const id = task();
    const turn = settledTurn(id, 1, claudeText("indexed once"), null);
    rmSync(turn.path);

    const state = await indexTurnProse({
      turnId: turn.id,
      taskId: id,
      logFile: turn.path,
      result: null,
      def: BUILTIN_ADAPTERS.claude,
    });

    expect(state).toBe("unavailable");
    // the row EXISTS, which is what stops the backfill retrying a lost log forever
    expect(getTurnText(turn.id)?.state).toBe("unavailable");
    expect(getTurnText(turn.id)?.text).toBe("");
  });
});

describe("finalizing a turn", () => {
  test("indexes its prose whatever the outcome, without being able to fail the turn", async () => {
    const id = task("finalized prose task");
    const turn = settledTurn(id, 1, claudeText("I looked at the coalescer first"), null);
    // a turn that has NOT settled cleanly is exactly the case worth covering:
    // it said things too, and the index is written before the outcome branches
    db.run(`UPDATE turns SET status = 'running', ended_at = NULL WHERE id = ?`, [turn.id]);

    await finalizeTurn(id, turn.id, BUILTIN_ADAPTERS.claude!, 1, turn.path, `${turn.path}.err`);

    expect(getTurnText(turn.id)?.text).toBe("I looked at the coalescer first");
  });
});

describe("the background backfill", () => {
  test("indexes settled turns it finds unindexed, newest first, and then stops", async () => {
    const id = task();
    const first = settledTurn(id, 1, claudeText("older backfilled prose"), null);
    const second = settledTurn(id, 2, claudeText("newer backfilled prose"), null);

    expect(pendingProseTurns().map((turn) => turn.id)).toEqual([second.id, first.id]);
    expect(countPendingProseTurns()).toBeGreaterThanOrEqual(2);

    await backfillTurnTexts(BUILTIN_ADAPTERS);

    expect(getTurnText(first.id)?.text).toBe("older backfilled prose");
    expect(getTurnText(second.id)?.text).toBe("newer backfilled prose");
    expect(countPendingProseTurns()).toBe(0);
  });

  test("leaves a running turn alone — its log is still being written", async () => {
    const id = task();
    const running = createTurn(id, 9, "still going", null, join(logDir(), "running.out.log"));

    await backfillTurnTexts(BUILTIN_ADAPTERS);

    expect(pendingProseTurns().map((turn) => turn.id)).not.toContain(running);
    expect(getTurnText(running)).toBeNull();
  });

  test("resumes: a second pass fills only what is still missing", async () => {
    const id = task();
    const done = settledTurn(id, 1, claudeText("already indexed"), null);
    await indexTurnProse({ turnId: done.id, taskId: id, logFile: done.path, result: null, def: BUILTIN_ADAPTERS.claude });
    const indexedAt = getTurnText(done.id)!.indexed_at;
    const fresh = settledTurn(id, 2, claudeText("not yet indexed"), null);

    expect(pendingProseTurns().map((turn) => turn.id)).toEqual([fresh.id]);
    await backfillTurnTexts(BUILTIN_ADAPTERS);

    expect(getTurnText(fresh.id)?.text).toBe("not yet indexed");
    // untouched, so a restart mid-history re-reads nothing it already read
    expect(getTurnText(done.id)?.indexed_at).toBe(indexedAt);
  });

  test("reports what is left, so a client can say the search is still catching up", async () => {
    const id = task();
    settledTurn(id, 1, claudeText("counted"), null);

    expect(turnTextIndexStatus().remaining).toBeGreaterThan(0);
    await backfillTurnTexts(BUILTIN_ADAPTERS);
    expect(turnTextIndexStatus().remaining).toBe(0);
  });
});

describe("searching the prose", () => {
  test("finds words the agent only said mid-turn, and says which turn said them", async () => {
    const id = task("prose search task");
    const turn = settledTurn(id, 3, claudeText("I rewired the coalescer before touching anything else"), "done");
    await indexTurnProse({ turnId: turn.id, taskId: id, logFile: turn.path, result: "done", def: BUILTIN_ADAPTERS.claude });

    const found = searchTasks("coalescer").tasks.find((candidate) => candidate.id === id);

    expect(found).toBeDefined();
    expect(found!.snippets.map((snippet) => snippet.kind)).toContain("prose");
    expect(found!.snippets.find((snippet) => snippet.kind === "prose")!.turn).toBe(3);
  });

  test("permanent deletion takes the index with it", async () => {
    const id = task("purged prose task");
    const turn = settledTurn(id, 1, claudeText("purgeable prose"), null);
    await indexTurnProse({ turnId: turn.id, taskId: id, logFile: turn.path, result: null, def: BUILTIN_ADAPTERS.claude });
    setTaskFields(id, { archived: 1 });

    await purgeTask(getTask(id)!);

    expect(getTurnText(turn.id)).toBeNull();
    expect(searchTasks("purgeable").tasks.some((candidate) => candidate.id === id)).toBe(false);
  });
});
