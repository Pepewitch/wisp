import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { SUFFIX_PROMPTS_PATH, type WispConfig } from "../src/config";
import { route } from "../src/routes";
import {
  createSuffixPrompt,
  deleteSuffixPrompt,
  DuplicateSuffixPromptNameError,
  listSuffixPrompts,
  promptWithSuffix,
  SUFFIX_PROMPT_SEPARATOR,
  updateSuffixPrompt,
} from "../src/suffix-prompts";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

beforeEach(() => rmSync(SUFFIX_PROMPTS_PATH, { force: true }));
afterEach(() => rmSync(SUFFIX_PROMPTS_PATH, { force: true }));

async function call(method: string, body?: unknown, path = "/api/suffix-prompts"): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return await route(new Request(url, init), url, url.pathname, cfg, BUILTIN_ADAPTERS);
}

describe("daemon-wide suffix prompt storage", () => {
  test("starts empty, persists atomically-shaped data, and appends with the exact separator", () => {
    expect(listSuffixPrompts()).toEqual([]);

    const saved = createSuffixPrompt("  Intensive review  ", "  Check everything carefully.  ");
    expect(saved).toMatchObject({
      name: "Intensive review",
      prompt: "Check everything carefully.",
    });
    expect(saved.id).not.toBe("");
    expect(saved.createdAt).not.toBe("");
    expect(listSuffixPrompts()).toEqual([saved]);
    expect(statSync(SUFFIX_PROMPTS_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(SUFFIX_PROMPTS_PATH, "utf8"))).toEqual({
      version: 1,
      suffixPrompts: [saved],
    });
    expect(promptWithSuffix("Review this PR", saved.id)).toBe(
      `Review this PR${SUFFIX_PROMPT_SEPARATOR}Check everything carefully.`,
    );
    expect(promptWithSuffix("Review this PR", undefined)).toBe("Review this PR");
    expect(promptWithSuffix("Review this PR", "missing")).toBeNull();
  });

  test("names are unique case-insensitively", () => {
    createSuffixPrompt("Review", "First");
    expect(() => createSuffixPrompt(" review ", "Second")).toThrow(DuplicateSuffixPromptNameError);
    expect(listSuffixPrompts()).toHaveLength(1);
  });

  test("updates keep identity and order, deletes report whether anything was there", () => {
    const first = createSuffixPrompt("Review", "First");
    const second = createSuffixPrompt("Audit", "Second");

    const updated = updateSuffixPrompt(first.id, "  Deep review ", " Check everything twice. ");
    expect(updated).toEqual({
      id: first.id,
      createdAt: first.createdAt,
      name: "Deep review",
      prompt: "Check everything twice.",
    });
    expect(listSuffixPrompts()).toEqual([updated, second]);

    expect(updateSuffixPrompt("missing", "n", "p")).toBeNull();
    expect(listSuffixPrompts()).toEqual([updated, second]);

    expect(deleteSuffixPrompt(first.id)).toBe(true);
    expect(listSuffixPrompts()).toEqual([second]);
    expect(deleteSuffixPrompt(first.id)).toBe(false);
  });

  test("a rename cannot collide with another prompt but may keep its own name", () => {
    const review = createSuffixPrompt("Review", "First");
    createSuffixPrompt("Audit", "Second");
    expect(() => updateSuffixPrompt(review.id, " audit ", "x")).toThrow(DuplicateSuffixPromptNameError);
    expect(updateSuffixPrompt(review.id, "REVIEW", "First v2")?.prompt).toBe("First v2");
    expect(listSuffixPrompts()).toHaveLength(2);
  });

  test("a malformed hand-edited store fails by file and field", () => {
    writeFileSync(SUFFIX_PROMPTS_PATH, JSON.stringify({ version: 1, suffixPrompts: [{ id: 42 }] }));
    expect(() => listSuffixPrompts()).toThrow(
      "suffix-prompts.json: suffixPrompts[0].id must be a string, got number",
    );
  });
});

describe("suffix prompt API", () => {
  test("lists, creates, trims, and rejects duplicate names", async () => {
    const empty = await call("GET");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ suffixPrompts: [] });

    const created = await call("POST", { name: "  Review loop ", prompt: "  Review, fix, repeat. " });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "Review loop",
      prompt: "Review, fix, repeat.",
    });

    const listed = await call("GET");
    expect(((await listed.json()) as { suffixPrompts: unknown[] }).suffixPrompts).toHaveLength(1);

    const duplicate = await call("POST", { name: "review LOOP", prompt: "Another" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "a suffix prompt named 'review LOOP' already exists" });
  });

  test("updates and deletes one record by id", async () => {
    const created = (await (
      await call("POST", { name: "Review", prompt: "First" })
    ).json()) as { id: string; createdAt: string };
    const path = `/api/suffix-prompts/${created.id}`;

    const updated = await call("PATCH", { name: " Deep review ", prompt: " Second " }, path);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      id: created.id,
      createdAt: created.createdAt,
      name: "Deep review",
      prompt: "Second",
    });

    expect((await call("PATCH", { name: "n", prompt: "p" }, "/api/suffix-prompts/nope")).status).toBe(404);

    const deleted = await call("DELETE", undefined, path);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(((await (await call("GET")).json()) as { suffixPrompts: unknown[] }).suffixPrompts).toHaveLength(0);
    expect((await call("DELETE", undefined, path)).status).toBe(404);
  });

  test("an update validates fields and rejects another prompt's name", async () => {
    const review = (await (await call("POST", { name: "Review", prompt: "a" })).json()) as { id: string };
    await call("POST", { name: "Audit", prompt: "b" });
    const path = `/api/suffix-prompts/${review.id}`;

    expect(await (await call("PATCH", {}, path)).json()).toEqual({ error: "name and prompt are required" });
    expect(await (await call("PATCH", { name: 42, prompt: "p" }, path)).json()).toEqual({
      error: "name must be a string, got number",
    });
    expect(await (await call("PATCH", { name: " ", prompt: "p" }, path)).json()).toEqual({
      error: "name must not be empty",
    });
    expect(await (await call("PATCH", { name: "n", prompt: [] }, path)).json()).toEqual({
      error: "prompt must be a string, got array",
    });
    expect(await (await call("PATCH", { name: "n", prompt: "\n" }, path)).json()).toEqual({
      error: "prompt must not be empty",
    });

    const conflict = await call("PATCH", { name: "audit", prompt: "x" }, path);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "a suffix prompt named 'audit' already exists" });
    // validation wins over the unknown-id 404 so a client learns its body is wrong first
    expect((await call("PATCH", {}, "/api/suffix-prompts/nope")).status).toBe(400);
  });

  test("validates every request field", async () => {
    expect(await (await call("POST", {})).json()).toEqual({ error: "name and prompt are required" });
    expect(await (await call("POST", { name: 42, prompt: "p" })).json()).toEqual({
      error: "name must be a string, got number",
    });
    expect(await (await call("POST", { name: " ", prompt: "p" })).json()).toEqual({
      error: "name must not be empty",
    });
    expect(await (await call("POST", { name: "n", prompt: [] })).json()).toEqual({
      error: "prompt must be a string, got array",
    });
    expect(await (await call("POST", { name: "n", prompt: "\n" })).json()).toEqual({
      error: "prompt must not be empty",
    });
  });
});
