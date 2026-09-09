import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";

import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import {
  createTask,
  createTaskMessage,
  createTurn,
  finishTurn,
  freeSlot,
  markTaskMessageDelivered,
  newTaskId,
  newTaskMessageId,
  setTaskFields,
} from "../src/store";
import { buildSnippet, escapeLike, searchTasks } from "../src/store-search";

function task(title: string): string {
  const id = newTaskId();
  createTask({ id, title, repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
  return id;
}

function turn(taskId: string, n: number, prompt: string, result: string | null): void {
  const rowId = createTurn(taskId, n, prompt, null, `/tmp/logs/${taskId}-${n}.jsonl`);
  if (result !== null) finishTurn(rowId, "done", 0, result);
}

function message(taskId: string, text: string): string {
  const id = newTaskMessageId();
  createTaskMessage({ id, taskId, text, attachmentHash: taskMessageAttachmentsFingerprint([]) });
  return id;
}

/** A hit for `id`, or a failure that names what the search actually returned. */
function hit(query: string, id: string) {
  const result = searchTasks(query);
  const found = result.tasks.find((candidate) => candidate.id === id);
  expect(found, `no hit for ${id} in ${JSON.stringify(result.tasks.map((t) => t.id))}`).toBeDefined();
  return found!;
}

describe("searchTasks", () => {
  test("finds a title, a prompt, a result and a queued message, and says where", () => {
    const id = task("Vacuum the SSE bridge");
    turn(id, 1, "please vacuum the reducer", "vacuumed 4 files");
    message(id, "also vacuum the sidebar");

    const found = hit("vacuum", id);
    expect(found.matches).toBe(4);
    expect(found.snippets.map((snippet) => snippet.kind)).toEqual(["title", "prompt", "result"]);
    expect(found.snippets[0]!.turn).toBeNull();
    expect(found.snippets[1]!.turn).toBe(1);
  });

  test("counts every occurrence in one field", () => {
    const id = task("counting");
    turn(id, 1, "tick tock tick tock tick", null);
    expect(hit("tick", id).matches).toBe(3);
  });

  test("is case-insensitive over ASCII and exact otherwise", () => {
    const id = task("Reducer");
    turn(id, 1, "the REDUCER kept its tail", null);
    expect(hit("reducer", id).matches).toBe(2);
    expect(searchTasks("reduce r").tasks.some((candidate) => candidate.id === id)).toBe(false);
  });

  test("skips archived tasks", () => {
    const id = task("archived haystack");
    turn(id, 1, "haystack", null);
    expect(hit("haystack", id).id).toBe(id);
    setTaskFields(id, { archived: 1 });
    expect(searchTasks("haystack").tasks.some((candidate) => candidate.id === id)).toBe(false);
  });

  test("treats LIKE wildcards as literal text", () => {
    const percent = task("100% done");
    const underscore = task("snake_case matters");
    task("plain words only");

    expect(searchTasks("100%").tasks.map((candidate) => candidate.id)).toEqual([percent]);
    expect(searchTasks("e_c").tasks.map((candidate) => candidate.id)).toEqual([underscore]);
    // `_` as a wildcard would match "100% done"; escaped, it matches nothing.
    expect(searchTasks("100_").tasks).toEqual([]);
  });

  test("does not count a delivered message twice with its turn prompt", () => {
    const id = task("delivery");
    const messageId = message(id, "unique-needle in a message");
    turn(id, 1, "unique-needle in a message", null);
    // the queue row is still 'queued' here, so both are searched: two hits
    expect(hit("unique-needle", id).matches).toBe(2);
    // once it BECAME the turn's prompt, only the turn carries it
    markTaskMessageDelivered(messageId, "started", 1);
    expect(hit("unique-needle", id).matches).toBe(1);
  });

  test("orders tasks newest-updated first", () => {
    const older = task("needle older");
    // updated_at has millisecond resolution; two rows born in the same
    // millisecond tie, and a tie is not what this test is about.
    Bun.sleepSync(2);
    const newer = task("needle newer");
    const ordered = searchTasks("needle").tasks.map((candidate) => candidate.id);
    expect(ordered.indexOf(newer)).toBeLessThan(ordered.indexOf(older));
  });

  test("an unmatched query answers with no tasks rather than everything", () => {
    task("nothing to see");
    expect(searchTasks("zzzz-no-such-text").tasks).toEqual([]);
  });
});

describe("snippets", () => {
  test("ellipsise both ends and keep the offset exact", () => {
    const text = `${"a".repeat(80)} findme ${"b".repeat(200)}`;
    const snippet = buildSnippet("prompt", 3, text, text.indexOf("findme"), "findme".length);
    expect(snippet.text.startsWith("…")).toBe(true);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.text.slice(snippet.offset, snippet.offset + snippet.length)).toBe("findme");
    expect(snippet.turn).toBe(3);
  });

  test("collapse newlines and tabs into one readable line", () => {
    const text = "wrote\n\n\tthe   file";
    const snippet = buildSnippet("result", null, text, text.indexOf("file"), 4);
    expect(snippet.text).toBe("wrote the file");
    expect(snippet.text.slice(snippet.offset, snippet.offset + snippet.length)).toBe("file");
  });

  test("a match at the very start takes no leading ellipsis", () => {
    const snippet = buildSnippet("title", null, "findme at the head", 0, 6);
    expect(snippet.offset).toBe(0);
    expect(snippet.text).toBe("findme at the head");
  });
});

describe("escapeLike", () => {
  test("escapes the three characters SQLite treats specially", () => {
    expect(escapeLike("100%_\\x")).toBe("100\\%\\_\\\\x");
  });
});

const token = "search-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

async function startServer(): Promise<string> {
  const config: WispConfig = {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos: [],
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config));
  server = await serve({ port: 0 });
  return `http://127.0.0.1:${server.port}`;
}

const get = (base: string, path: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe("GET /api/search", () => {
  test("answers hits for the live tasks and echoes the query", async () => {
    const base = await startServer();
    const id = task("Route level needle");
    turn(id, 1, "the needle is in the prompt", null);

    const response = await get(base, "/api/search?q=needle");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { query: string; truncated: boolean; tasks: { id: string }[] };
    expect(body.query).toBe("needle");
    expect(body.truncated).toBe(false);
    expect(body.tasks.some((candidate) => candidate.id === id)).toBe(true);
  });

  test("percent-encoded text survives the round trip", async () => {
    const base = await startServer();
    const id = task("100% of the sidebar");
    const response = await get(base, `/api/search?q=${encodeURIComponent("100% of")}`);
    const body = (await response.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((candidate) => candidate.id)).toEqual([id]);
  });

  test("refuses a missing, empty or oversized query instead of answering with everything", async () => {
    const base = await startServer();
    task("a task nobody asked for");

    expect(await (await get(base, "/api/search")).json()).toEqual({ error: "q is required" });
    expect(await (await get(base, "/api/search?q=")).json()).toEqual({ error: "q must not be empty" });
    expect(await (await get(base, "/api/search?q=%20%20")).json()).toEqual({ error: "q must not be empty" });
    const long = "x".repeat(201);
    expect(await (await get(base, `/api/search?q=${long}`)).json()).toEqual({
      error: "q must be at most 200 characters, got 201",
    });
    for (const path of ["/api/search", "/api/search?q=", `/api/search?q=${long}`]) {
      expect((await get(base, path)).status).toBe(400);
    }
  });

  test("trims a trailing keystroke rather than answering nothing", async () => {
    const base = await startServer();
    const id = task("a trimmed-needle title");
    const response = await get(base, `/api/search?q=${encodeURIComponent("trimmed-needle ")}`);
    const body = (await response.json()) as { query: string; tasks: { id: string }[] };
    expect(body.query).toBe("trimmed-needle");
    expect(body.tasks.map((candidate) => candidate.id)).toEqual([id]);
  });

  test("rejects a write to the search route", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/search?q=needle`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(405);
  });
});
