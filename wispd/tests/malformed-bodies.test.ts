/**
 * The malformed-input matrix (ENG-09).
 *
 * A review found that every mutating route did
 * `(await req.json().catch(() => ({}))) as { … }` and then dereferenced the
 * result. `null`, `[]`, `7`, and `"text"` are all valid JSON, so the `catch`
 * never fired and the next line dereferenced a non-object.
 * `POST /api/tasks/:id/send` had no `catch` at all, so an unparseable body
 * became a 500 carrying a JSON parser message.
 *
 * The contract this pins down: every body shape below is answered with a
 * NAMED 4xx and no side effect. Two shapes are deliberately not errors — an
 * empty body and `{}` — because a caller with no options to send is making a
 * request, not a mistake.
 */
import { describe, expect, test } from "bun:test";

import { BUILTIN_ADAPTERS } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { createTask, freeSlot, getTask, listTasks, newTaskId, setTaskFields, transition } from "../src/store";
import { listSuffixPrompts } from "../src/suffix-prompts";

const token = "malformed-body-token";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
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

function call(path: string, method: string, body: string): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return Promise.resolve(
    route(
      new Request(url, {
        method,
        body,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
      url,
      url.pathname,
      cfg,
      BUILTIN_ADAPTERS,
    ),
  );
}

/** Every body that is valid JSON but not an object, plus one that is not JSON at all. */
const MALFORMED = [
  { label: "null", body: "null" },
  { label: "an array", body: "[]" },
  { label: "a number", body: "7" },
  { label: "a string", body: '"message"' },
  { label: "a boolean", body: "true" },
  { label: "unparseable bytes", body: "{" },
  { label: "a truncated object", body: '{"message":' },
];

/** A task that exists and can accept a mutation, so a 404/409 cannot mask the 400. */
function readyTask(): string {
  const id = newTaskId();
  createTask({
    id,
    title: "malformed body fixture",
    repo_path: "/tmp/repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(id, { worktree_path: "/tmp/worktree", branch: "wisp/x", session_id: "s1" });
  transition(id, "needs-input", "ready for a message");
  return id;
}

describe("every mutating route answers a malformed body with a named 4xx", () => {
  const taskId = readyTask();
  const routes: { name: string; path: string; method: string }[] = [
    { name: "create a task", path: "/api/tasks", method: "POST" },
    { name: "send a message", path: `/api/tasks/${taskId}/send`, method: "POST" },
    { name: "rename a task", path: `/api/tasks/${taskId}`, method: "PATCH" },
    { name: "archive a task", path: `/api/tasks/${taskId}/archive`, method: "POST" },
    { name: "create a suffix prompt", path: "/api/suffix-prompts", method: "POST" },
    { name: "add a project", path: "/api/repos", method: "POST" },
  ];

  for (const { name, path, method } of routes) {
    for (const { label, body } of MALFORMED) {
      test(`${name}: ${label}`, async () => {
        const before = { tasks: listTasks(true).length, prompts: listSuffixPrompts().length };

        const response = await call(path, method, body);

        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        const payload = (await response.json()) as { error?: unknown };
        expect(typeof payload.error).toBe("string");
        expect(payload.error).not.toBe("");
        // Nothing was created on the way to the refusal.
        expect({ tasks: listTasks(true).length, prompts: listSuffixPrompts().length }).toEqual(before);
      });
    }
  }
});

describe("the two shapes that are not errors", () => {
  test("an empty body is treated as no options, not as a malformed request", async () => {
    const taskId = readyTask();
    // /archive with no options is the CLI's ordinary plain archive.
    const response = await call(`/api/tasks/${taskId}/archive`, "POST", "");
    expect(response.status).toBe(200);
    expect(getTask(taskId)!.archived).toBe(1);
  });

  test("an empty object is the same request", async () => {
    const taskId = readyTask();
    const response = await call(`/api/tasks/${taskId}/archive`, "POST", "{}");
    expect(response.status).toBe(200);
    expect(getTask(taskId)!.archived).toBe(1);
  });
});

describe("the messages name what arrived", () => {
  test("a non-object body says which type it was", async () => {
    const response = await call("/api/suffix-prompts", "POST", "[]");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("request body must be a JSON object, got array");
  });

  test("unparseable bytes are not reported as a missing field", async () => {
    const response = await call("/api/suffix-prompts", "POST", "{");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("not valid JSON");
  });

  test("a wrong-typed field is still refused by its own validator", async () => {
    const response = await call("/api/suffix-prompts", "POST", JSON.stringify({ name: 7, prompt: "x" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("name must be a string, got number");
  });

  test("archive's force flag must be a boolean", async () => {
    const taskId = readyTask();
    const response = await call(`/api/tasks/${taskId}/archive`, "POST", JSON.stringify({ force: "yes" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("force must be a boolean, got string");
    expect(getTask(taskId)!.archived).toBe(0);
  });
});
