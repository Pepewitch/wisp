import { afterEach, describe, expect, test } from "bun:test";
import type { VerificationCheckout, VerificationStatus } from "../../shared/api/auto-review";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { loadConfig, type WispConfig } from "../src/config";
import { verificationRoute } from "../src/routes/auto-review";
import { addProjectRoute } from "../src/routes/projects";
import type { ModelProbeCache } from "../src/model-probes";
import type { NewTaskInput } from "../src/domain/task-create";
import { createTask, freeSlot, getTask, newTaskId, transition } from "../src/store";
import { activateDraft, activeRecipe, saveDraft } from "../src/verify/recipe";
import { startRecipeTask } from "../src/verify/reviewer";
import { recordVerifyTask } from "../src/verify/status";
import { created, forgetTasks } from "./autopilot-harness";

afterEach(forgetTasks);

const RECIPE = [{ path: "RECIPE.md", content: "# Fixture" }, { path: "areas/web/AREA.md", content: "---\npaths: web/**\nstatus: proven\n---\n" }];

function call(cfg: WispConfig, method: string, path: string, body?: unknown, query = "", headers: Record<string, string> = {}) {
  const url = new URL(`http://wisp${path}${query}`);
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return verificationRoute(req, url, path, method, cfg, {}, null as unknown as ModelProbeCache) as Promise<Response> | Response;
}

function recipeTask(repo: string, role: "recipe" | "reviewer" = "recipe"): string {
  const id = newTaskId();
  createTask({ id, title: "Set up verification", repo_path: repo, harness: "fake", model: null, verify_role: role, slot: freeSlot() });
  created.push(id);
  if (role === "recipe") recordVerifyTask({ taskId: id, projectPath: repo, mode: "setup", area: null, roundId: null });
  return id;
}

describe("verification routes", () => {
  test("only a recipe task saves a draft, and a person activates it", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    const reviewer = recipeTask(repo, "reviewer");
    const from = (task: string) => ({ "x-wisp-client": "cli", "x-wisp-task": task });
    expect((await call(cfg, "POST", "/api/projects/verification/draft", { task: reviewer, files: RECIPE }, "", from(reviewer))).status).toBe(403);
    const setup = recipeTask(repo);
    // another task's turn cannot save in this recipe task's name
    expect((await call(cfg, "POST", "/api/projects/verification/draft", { task: setup, files: RECIPE }, "", from(reviewer))).status).toBe(403);
    const bad = await call(cfg, "POST", "/api/projects/verification/draft", { task: setup, files: [{ path: "x.md", content: "" }] }, "", from(setup));
    expect(bad.status).toBe(400);
    const saved = await call(cfg, "POST", "/api/projects/verification/draft", { task: setup, files: RECIPE }, "", from(setup));
    expect(saved.status).toBe(200);

    const status = await (await call(cfg, "GET", "/api/projects/verification", undefined, `?path=${encodeURIComponent(repo)}`)).json() as Record<string, unknown>;
    expect(status).toMatchObject({ state: "none", draft: { taskId: setup }, task: { id: setup, mode: "setup" } });
    expect(activeRecipe(repo)).toBeNull();

    // an agent proposes; only a person activates
    expect((await call(cfg, "POST", "/api/projects/verification/activate", { path: repo }, "", from(setup))).status).toBe(403);
    const activated = await call(cfg, "POST", "/api/projects/verification/activate", { path: repo }, "", { "x-wisp-client": "web" });
    expect(activated.status).toBe(200);
    const after = await (await call(cfg, "GET", "/api/projects/verification", undefined, `?path=${encodeURIComponent(repo)}`)).json() as Record<string, unknown>;
    expect(after).toMatchObject({ state: "active", draft: null, areas: [{ name: "web", status: "proven", attention: null }] });

    const file = await (await call(cfg, "GET", "/api/projects/verification/files", undefined, `?path=${encodeURIComponent(repo)}&file=RECIPE.md`)).json() as { content: string };
    expect(file.content).toBe("# Fixture");
    const missing = await call(cfg, "GET", "/api/projects/verification/files", undefined, `?path=${encodeURIComponent(repo)}&file=..%2Fsecret`);
    expect(missing.status).toBe(404);
    // a draft name is a task id, never a path out of the drafts directory
    for (const draft of ["..%2F..%2F..", "..", "a%2Fb"]) {
      expect((await call(cfg, "GET", "/api/projects/verification/files", undefined, `?path=${encodeURIComponent(repo)}&file=RECIPE.md&draft=${draft}`)).status).toBe(400);
      expect((await call(cfg, "GET", "/api/projects/verification/checkout", undefined, `?path=${encodeURIComponent(repo)}&draft=${draft}`)).status).toBe(400);
    }
  });

  test("a recipe task needs an agent: the request's, or the project's", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    const res = await call(cfg, "POST", "/api/projects/verification/tasks", { path: repo, mode: "setup" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("harness is required");
    expect((await call(cfg, "POST", "/api/projects/verification/tasks", { path: repo, mode: "audit" })).status).toBe(400);
    expect((await call(cfg, "POST", "/api/projects/verification/tasks", { path: "relative", mode: "setup" })).status).toBe(400);
  });

  test("a second recipe task waits for the one at work", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    recipeTask(repo); // 'creating': still at work
    const res = await call(cfg, "POST", "/api/projects/verification/tasks", { path: repo, mode: "improve", harness: "fake" });
    expect(res.status).toBe(409);
  });
});

describe("a waiting draft", () => {
  const DRAFT = [{ path: "RECIPE.md", content: "# Drafted" }, { path: "areas/web/AREA.md", content: "---\npaths: web/**, docs/**\nstatus: proven\n---\n" }];
  const checkout = async (repo: string, query = "") =>
    (await call(loadConfig(), "GET", "/api/projects/verification/checkout", undefined, `?path=${encodeURIComponent(repo)}${query}`)).json() as Promise<VerificationCheckout>;

  /** A project with an active recipe, and a newer draft from a recipe task that has finished. */
  async function project() {
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-draft-"));
    saveDraft(repo, "tfirst", RECIPE);
    await activateDraft(repo, "test");
    const drafted = recipeTask(repo);
    transition(drafted, "running");
    transition(drafted, "done");
    saveDraft(repo, drafted, DRAFT);
    return { repo, drafted };
  }

  /** Press Improve: a recipe task on a launcher that only records what it was asked to start. */
  async function improve(repo: string) {
    const launched: NewTaskInput[] = [];
    const launch = async (input: NewTaskInput) => {
      launched.push(input);
      const id = newTaskId();
      createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: null, verify_role: "recipe", slot: freeSlot() });
      created.push(id);
      input.prepare?.(getTask(id)!);
      return { task: getTask(id)!, autopilot: null } as never;
    };
    const started = await startRecipeTask({ cfg: loadConfig(), adapters: {}, launch }, {
      repoPath: repo, projectName: "p", mode: "improve", area: null, note: null, complaints: [], agent: { harness: "fake" }, roundId: null, actor: "web",
    });
    return { launched, started };
  }

  test("the status says how old the draft and the active recipe are", async () => {
    const { repo, drafted } = await project();
    const status = await (await call(loadConfig(), "GET", "/api/projects/verification", undefined, `?path=${encodeURIComponent(repo)}`)).json() as VerificationStatus;
    expect(status.state).toBe("active");
    expect(status.draft?.taskId).toBe(drafted);
    for (const at of [status.activatedAt, status.draft?.savedAt]) {
      expect(typeof at).toBe("string");
      expect(Date.now() - Date.parse(at!)).toBeLessThan(60_000);
    }
    expect(Date.parse(status.draft!.savedAt)).toBeGreaterThanOrEqual(Date.parse(status.activatedAt!));
  });

  test("an improve starts from the newest draft, and its checkout returns the draft's files", async () => {
    const { repo, drafted } = await project();
    const { launched, started } = await improve(repo);
    expect("task" in started && started.draft?.taskId).toBe(drafted);
    const prompt = launched[0]!.firstTurnPrompt!;
    expect(prompt).toContain(`Start from the waiting draft from task ${drafted}`);
    expect(prompt).not.toContain("Start from the active recipe");

    // what that prompt tells it to run: the newest draft, unless it asks for the active recipe
    const fromDraft = await checkout(repo);
    expect(fromDraft.draft?.taskId).toBe(drafted);
    expect(fromDraft.files.find((file) => file.path === "RECIPE.md")?.content).toBe("# Drafted");
    const fromActive = await checkout(repo, "&active=1");
    expect(fromActive.draft).toBeNull();
    expect(fromActive.files.find((file) => file.path === "RECIPE.md")?.content).toBe("# Fixture");
    expect((await call(loadConfig(), "GET", "/api/projects/verification/checkout", undefined, `?path=${encodeURIComponent(repo)}&active=1&draft=${drafted}`)).status).toBe(400);
  });

  test("with no draft waiting, a recipe task starts from the active recipe", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-draft-"));
    saveDraft(repo, "tfirst", RECIPE);
    await activateDraft(repo, "test");
    const { launched, started } = await improve(repo);
    expect("task" in started && started.draft).toBeNull();
    expect(launched[0]!.firstTurnPrompt).toContain("Start from the active recipe");
    expect((await checkout(repo)).draft).toBeNull();
  });
});

describe("the second reviewer and the rubric", () => {
  test("a save of the first reviewer alone (an older client's) keeps the second reviewer", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    const save = (body: Record<string, unknown>) => addProjectRoute(new Request("http://wisp/api/projects", {
      method: "POST", body: JSON.stringify({ path: repo, ...body }), headers: { "content-type": "application/json" },
    }), cfg, BUILTIN_ADAPTERS);
    const first = await (await save({ verify: { harness: "claude" }, verifySecond: { harness: "codex", model: "gpt-6.1-sol" } })).json() as Record<string, unknown>;
    expect(first).toMatchObject({ verify: { harness: "claude" }, verifySecond: { harness: "codex", model: "gpt-6.1-sol" } });
    const later = await (await save({ verify: { harness: "droid" } })).json() as Record<string, unknown>;
    expect(later).toMatchObject({ verify: { harness: "droid" }, verifySecond: { harness: "codex", model: "gpt-6.1-sol" } });
    expect(await (await save({ verifySecond: "off" })).json()).toMatchObject({ verifySecond: "off" });
    expect(await (await save({ verifySecond: null })).json()).toMatchObject({ verifySecond: null });
    expect((await save({ verifySecond: 3 })).status).toBe(400);
    // a wrong field inside the agent is the caller's mistake too, not a 500
    expect((await save({ verifySecond: { harness: 7 } })).status).toBe(400);
    expect((await save({ verifySecond: { harness: "codex", colour: "red" } })).status).toBe(400);
  });

  test("each reviewer's fallback is its own patch: set, kept by other saves, cleared by null, and in the status", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    const save = (body: Record<string, unknown>) => addProjectRoute(new Request("http://wisp/api/projects", {
      method: "POST", body: JSON.stringify({ path: repo, ...body }), headers: { "content-type": "application/json" },
    }), cfg, BUILTIN_ADAPTERS);
    const first = await (await save({ verifyFallback: { harness: "claude", model: "opus-5", effort: "high" }, verifySecondFallback: { harness: "codex" } })).json();
    expect(first).toMatchObject({ verifyFallback: { harness: "claude", model: "opus-5", effort: "high" }, verifySecondFallback: { harness: "codex" } });
    // a save of anything else (an older client's) keeps both
    expect(await (await save({ verify: { harness: "droid" }, verifySecond: "off" })).json())
      .toMatchObject({ verifyFallback: { harness: "claude" }, verifySecondFallback: { harness: "codex" } });
    const status = await (await call(cfg, "GET", "/api/projects/verification", undefined, `?path=${encodeURIComponent(repo)}`)).json() as VerificationStatus;
    expect(status.fallbacks).toEqual({ primary: { harness: "claude", model: "opus-5", effort: "high" }, second: { harness: "codex", model: null, effort: null } });
    expect(await (await save({ verifyFallback: null })).json()).toMatchObject({ verifyFallback: null, verifySecondFallback: { harness: "codex" } });
    expect((await save({ verifySecondFallback: "off" })).status).toBe(400);
    expect((await save({ verifyFallback: { harness: "codex", colour: "red" } })).status).toBe(400);
    // a harness this daemon does not have would only be skipped when it is needed
    const unknown = await save({ verifySecondFallback: { harness: "nosuchharness" } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("verifySecondFallback.harness 'nosuchharness' is not a harness this daemon has");
  });

  test("the rubric route carries the project's own review rules", async () => {
    const cfg = loadConfig();
    const repo = mkdtempSync(join(tmpdir(), "wisp-verify-route-"));
    const setup = recipeTask(repo);
    const files = [{ path: "RECIPE.md", content: "# Fixture\n\n## Review rules\n\nNever log a user's email.\n\n## Checks\n\nbun test\n" }, RECIPE[1]];
    expect((await call(cfg, "POST", "/api/projects/verification/draft", { task: setup, files }, "", { "x-wisp-client": "cli", "x-wisp-task": setup })).status).toBe(200);
    await call(cfg, "POST", "/api/projects/verification/activate", { path: repo });
    const { text } = await (await call(cfg, "GET", "/api/projects/verification/rubric", undefined, `?path=${encodeURIComponent(repo)}`)).json() as { text: string };
    expect(text).toContain("Never log a user's email.");
    expect(text).not.toContain("bun test");
    expect(text).toContain("slop:");
  });
});
