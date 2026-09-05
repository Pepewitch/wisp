import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import { CONFIG_PATH, LOG_DIR, type WispConfig } from "../src/config";
import { ModelProbeCache } from "../src/model-probes";
import { route, serve } from "../src/daemon";
import { subscribe, type WispEvent } from "../src/events";
import {
  createTask,
  createTaskMessage,
  createTurn,
  finishTurn,
  freeSlot,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
} from "../src/store";

const token = "web-test-token";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let server: Awaited<ReturnType<typeof serve>> | null = null;

function config(repos: WispConfig["repos"] = []): WispConfig {
  return {
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos,
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
}

function writeConfig(repos: WispConfig["repos"] = []): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config(repos)));
}

async function startServer(repos: WispConfig["repos"] = []): Promise<string> {
  writeConfig(repos);
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("contract probe failed");
    },
    modelProbeTimeoutMs: 100,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

async function api(base: string, path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${path}`, init);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function expectError(base: string, path: string, status: number, message: string, method = "GET", body?: unknown) {
  const res = await api(base, path, method, body);
  expect(res.status).toBe(status);
  expect(await json<{ error: string }>(res)).toEqual({ error: message });
}

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  return createTask({
    id: newTaskId(),
    title: "daemon API contract task",
    repo_path: "/tmp/wisp-contract-repo",
    harness: "claude",
    model: null,
    slot: freeSlot(),
    ...overrides,
  });
}

function shell(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function makeRepo(): { path: string; branch: string; base: string } {
  const path = mkdtempSync(join(tmpdir(), "wisp-api-contract-repo-"));
  shell(path, ["init", "-q"]);
  writeFileSync(join(path, "README.md"), "contract test\n");
  shell(path, ["add", "README.md"]);
  shell(path, ["-c", "user.email=contract@test", "-c", "user.name=contract-test", "commit", "-q", "-m", "init"]);
  return { path, branch: shell(path, ["branch", "--show-current"]), base: shell(path, ["rev-parse", "HEAD"]) };
}

describe("daemon API contracts", () => {
  test("lists tasks, returns detail, and reads the selected log turn", async () => {
    const base = await startServer();
    const task = makeTask({ title: "listed contract task", repo_path: "/tmp/wisp-list-repo" });
    const logFile = join(LOG_DIR, `${task.id}-turn1.out.log`);
    writeFileSync(logFile, "stdout\n");
    writeFileSync(logFile.replace(/\.out\.log$/, ".err.log"), "stderr\n");
    const turnId = createTurn(task.id, 1, "inspect the API", null, logFile);
    finishTurn(turnId, "done", 0, "finished");
    setTaskFields(task.id, { turn_count: 1 });
    transition(task.id, "done", "finished");

    const archived = makeTask({ title: "archived contract task" });
    setTaskFields(archived.id, { archived: 1 });

    const listed = await api(base, "/api/tasks");
    expect(listed.status).toBe(200);
    const rows = await json<Array<Record<string, unknown>>>(listed);
    expect(rows.find((row) => row.id === archived.id)).toBeUndefined();
    expect(rows.find((row) => row.id === task.id)).toMatchObject({
      id: task.id,
      title: "listed contract task",
      archived: false,
      state: "done",
      latest_turn_model: null,
    });

    const all = await api(base, "/api/tasks?archived=1");
    expect(all.status).toBe(200);
    const allRows = await json<Array<Record<string, unknown>>>(all);
    expect(allRows.find((row) => row.id === archived.id)).toMatchObject({ id: archived.id, archived: true });

    const detail = await api(base, `/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await json<{
      id: string;
      archived: boolean;
      turns: Array<Record<string, unknown>>;
      diffstat: string | null;
    }>(detail);
    expect(detailBody).toMatchObject({ id: task.id, archived: false, diffstat: null });
    expect(detailBody.turns).toHaveLength(1);
    expect(detailBody.turns[0]).toMatchObject({ n: 1, prompt: "inspect the API", status: "done", result: "finished" });

    const log = await api(base, `/api/tasks/${task.id}/log?offset=0`);
    expect(log.status).toBe(200);
    expect(await json(log)).toEqual({
      turn: 1,
      status: "done",
      harness: "claude",
      size: 7,
      out: "stdout\n",
      err: "stderr\n",
    });
    // a malformed turn is a 400 naming the parameter; a well-formed turn
    // that does not exist stays the 404 `wisp log <task> 99` reports
    await expectError(base, `/api/tasks/${task.id}/log?turn=wat`, 400, 'turn must be a positive integer, got "wat"');
    await expectError(base, `/api/tasks/${task.id}/log?turn=0`, 400, 'turn must be a positive integer, got "0"');
    await expectError(base, `/api/tasks/${task.id}/log?turn=-1`, 400, 'turn must be a positive integer, got "-1"');
    await expectError(base, `/api/tasks/${task.id}/log?turn=1.5`, 400, 'turn must be a positive integer, got "1.5"');
    await expectError(base, `/api/tasks/${task.id}/log?turn=2`, 404, "no turn 2");
    // same class: offset=abc used to become NaN and silently take the tail branch
    await expectError(base, `/api/tasks/${task.id}/log?offset=abc`, 400, 'offset must be a non-negative integer, got "abc"');
    await expectError(base, `/api/tasks/${task.id}/log?offset=-1`, 400, 'offset must be a non-negative integer, got "-1"');
    await expectError(base, `/api/tasks/${task.id}/log?offset=1.5`, 400, 'offset must be a non-negative integer, got "1.5"');
    await expectError(base, "/api/tasks/tnope9/log", 404, "no such task: tnope9");
    await expectError(base, "/api/tasks/tnope9", 404, "no such task: tnope9");
  });

  test("renames a task and validates the display title", async () => {
    const base = await startServer();
    const task = makeTask({ title: "First prompt became this title" });
    const events: WispEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));

    try {
      const renamed = await api(base, `/api/tasks/${task.id}`, "PATCH", { title: "  A clearer task name  " });
      expect(renamed.status).toBe(200);
      const renamedBody = await json<{ title: string; updated_at: string }>(renamed);
      expect(renamedBody).toMatchObject({ title: "A clearer task name" });

      const unchanged = await api(base, `/api/tasks/${task.id}`, "PATCH", { title: "A clearer task name" });
      expect(await json<{ updated_at: string }>(unchanged)).toMatchObject({ updated_at: renamedBody.updated_at });
      expect(events).toEqual([
        expect.objectContaining({
          type: "task",
          taskId: task.id,
          title: "A clearer task name",
          updatedAt: renamedBody.updated_at,
        }),
      ]);

      const detail = await api(base, `/api/tasks/${task.id}`);
      expect(await json<{ title: string }>(detail)).toMatchObject({ title: "A clearer task name" });

      await expectError(base, `/api/tasks/${task.id}`, 400, "title is required", "PATCH", {});
      await expectError(base, `/api/tasks/${task.id}`, 400, "title must be a string, got number", "PATCH", {
        title: 42,
      });
      await expectError(base, `/api/tasks/${task.id}`, 400, "title must not be empty", "PATCH", { title: "   " });
      await expectError(
        base,
        `/api/tasks/${task.id}`,
        400,
        "title must be at most 80 characters",
        "PATCH",
        { title: "x".repeat(81) },
      );
    } finally {
      unsubscribe();
    }
  });

  test("send queues active work without interrupting and pins validation errors", async () => {
    const base = await startServer();
    await expectError(base, "/api/tasks/tnope9/send", 404, "no such task: tnope9", "POST", { message: "hi" });

    const missingMessage = makeTask();
    transition(missingMessage.id, "done", "ready");
    await expectError(base, `/api/tasks/${missingMessage.id}/send`, 400, "message is required", "POST", {});
    await expectError(base, `/api/tasks/${missingMessage.id}/send`, 400, "message is required", "POST", { message: "" });
    await expectError(
      base,
      `/api/tasks/${missingMessage.id}/send`,
      409,
      "task has no worktree (failed before setup?)",
      "POST",
      { message: "hi" },
    );

    const archived = makeTask();
    setTaskFields(archived.id, { archived: 1 });
    // the long form — send's short "task is archived" predated the siblings and is unified
    await expectError(base, `/api/tasks/${archived.id}/send`, 409, "task is archived — archived tasks are read-only", "POST", { message: "hi" });

    const creating = makeTask();
    await expectError(
      base,
      `/api/tasks/${creating.id}/send`,
      409,
      "task is still being created",
      "POST",
      { message: "hi" },
    );

    const running = makeTask();
    setTaskFields(running.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-send-worktree-")) });
    createTurn(running.id, 1, "running", null, join(LOG_DIR, `${running.id}-turn1.out.log`));
    transition(running.id, "running", "turn 1");
    const queuedRes = await api(base, `/api/tasks/${running.id}/send`, "POST", {
      message: "hi",
      clientMessageId: "retry-safe-0001",
    });
    expect(queuedRes.status).toBe(200);
    const queued = await json<{
      disposition: string;
      message: Record<string, unknown> & { id: string; status: string };
    }>(queuedRes);
    expect(queued.disposition).toBe("queued-next");
    expect(queued.message).toMatchObject({
      id: "retry-safe-0001",
      status: "queued",
      delivery_uncertain: false,
    });
    expect(queued.message).not.toHaveProperty("attachment_hash");
    expect(queued.message).not.toHaveProperty("claim");
    expect(turnsFor(running.id)[0]?.status).toBe("running"); // send never interrupts

    // Retrying the same stable id is idempotent, and a queued message can be edited/cancelled.
    const retry = await json<{ message: { id: string } }>(
      await api(base, `/api/tasks/${running.id}/send`, "POST", {
        message: "hi",
        clientMessageId: "retry-safe-0001",
      }),
    );
    expect(retry.message.id).toBe("retry-safe-0001");

    const imageRequest = {
      message: "inspect this",
      clientMessageId: "retry-image-0001",
      attachments: [{ name: "image.png", dataBase64: PNG.toString("base64") }],
    };
    expect((await api(base, `/api/tasks/${running.id}/send`, "POST", imageRequest)).status).toBe(200);
    expect((await api(base, `/api/tasks/${running.id}/send`, "POST", imageRequest)).status).toBe(200);
    const changedImage = await api(base, `/api/tasks/${running.id}/send`, "POST", {
      ...imageRequest,
      attachments: [
        {
          name: "image.png",
          dataBase64: Buffer.concat([PNG, Buffer.from([1])]).toString("base64"),
        },
      ],
    });
    expect(changedImage.status).toBe(409);
    expect(await json<{ error: string }>(changedImage)).toEqual({
      error: "message id retry-image-0001 was already used for different content",
    });
    const queuedImagePath = `/api/tasks/${running.id}/messages/retry-image-0001/attachments/image.png`;
    expect((await api(base, queuedImagePath)).status).toBe(200);
    expect((await api(base, `/api/tasks/${running.id}/messages/retry-image-0001`, "DELETE")).status).toBe(200);
    await expectError(base, queuedImagePath, 410, "image.png was removed when this message was cancelled");

    const edited = await json<{ text: string }>(
      await api(base, `/api/tasks/${running.id}/messages/retry-safe-0001`, "PATCH", { message: "wait instead" }),
    );
    expect(edited.text).toBe("wait instead");
    const cancelled = await json<{ status: string }>(
      await api(base, `/api/tasks/${running.id}/messages/retry-safe-0001`, "DELETE"),
    );
    expect(cancelled.status).toBe("cancelled");
    await expectError(
      base,
      `/api/tasks/${running.id}/send`,
      409,
      "message id retry-safe-0001 was cancelled",
      "POST",
      { message: "wait instead", clientMessageId: "retry-safe-0001" },
    );

    const unknownHarness = makeTask({ harness: "mystery" });
    setTaskFields(unknownHarness.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-send-harness-")) });
    transition(unknownHarness.id, "done", "ready");
    await expectError(base, `/api/tasks/${unknownHarness.id}/send`, 500, "unknown harness: mystery", "POST", { message: "hi" });

    const archivedQueued = makeTask();
    createTaskMessage({
      id: "archived-message-1",
      taskId: archivedQueued.id,
      text: "never delivered",
      attachmentHash: taskMessageAttachmentsFingerprint([]),
    });
    setTaskFields(archivedQueued.id, { archived: 1 });
    const archivedError = "task is archived — archived tasks are read-only";
    await expectError(
      base,
      `/api/tasks/${archivedQueued.id}/messages/archived-message-1`,
      409,
      archivedError,
      "PATCH",
      { message: "changed" },
    );
    await expectError(
      base,
      `/api/tasks/${archivedQueued.id}/messages/archived-message-1`,
      409,
      archivedError,
      "DELETE",
    );
  });
});

describe("daemon API contracts", () => {
  test("interrupt, push, attach, and diff expose their refusal and happy shapes", async () => {
    const base = await startServer();

    const noTurn = makeTask();
    await expectError(base, `/api/tasks/${noTurn.id}/interrupt`, 409, "no running turn to interrupt", "POST");

    // interrupt and push refuse an archived task the way send, diff and
    // fresh-session already did — the archived answer, not a side effect
    const archivedInterrupt = makeTask();
    setTaskFields(archivedInterrupt.id, { archived: 1 });
    await expectError(
      base,
      `/api/tasks/${archivedInterrupt.id}/interrupt`,
      409,
      "task is archived — archived tasks are read-only",
      "POST",
    );

    const noPid = makeTask();
    createTurn(noPid.id, 1, "pidless", null, join(LOG_DIR, `${noPid.id}-turn1.out.log`));
    await expectError(base, `/api/tasks/${noPid.id}/interrupt`, 409, "running turn has no pid to signal", "POST");
    await expectError(base, "/api/tasks/tnope9/interrupt", 404, "no such task: tnope9", "POST");

    await expectError(base, "/api/tasks/tnope9/push", 404, "no such task: tnope9", "POST");
    const noPushWorktree = makeTask();
    await expectError(base, `/api/tasks/${noPushWorktree.id}/push`, 409, "task has no worktree/branch", "POST");
    const noPushBranch = makeTask();
    setTaskFields(noPushBranch.id, { worktree_path: mkdtempSync(join(tmpdir(), "wisp-push-worktree-")) });
    await expectError(base, `/api/tasks/${noPushBranch.id}/push`, 409, "task has no worktree/branch", "POST");
    const archivedPush = makeTask();
    setTaskFields(archivedPush.id, { archived: 1 });
    await expectError(
      base,
      `/api/tasks/${archivedPush.id}/push`,
      409,
      "task is archived — archived tasks are read-only",
      "POST",
    );

    await expectError(base, "/api/tasks/tnope9/attach", 404, "no such task: tnope9");
    const noSession = makeTask();
    expect(await json(await api(base, `/api/tasks/${noSession.id}/attach`))).toEqual({ argv: null, message: "no session yet" });

    const attachWorktree = mkdtempSync(join(tmpdir(), "wisp-attach-worktree-"));
    const attached = makeTask();
    setTaskFields(attached.id, { worktree_path: attachWorktree, session_id: "session-123" });
    expect(await json(await api(base, `/api/tasks/${attached.id}/attach`))).toEqual({
      argv: ["claude", "--resume", "session-123"],
      cwd: attachWorktree,
      message: null,
    });

    const droid = makeTask({ harness: "droid" });
    setTaskFields(droid.id, { session_id: "droid-session" });
    expect(await json(await api(base, `/api/tasks/${droid.id}/attach`))).toEqual({
      argv: null,
      cwd: null,
      message: "harness 'droid' has no known interactive attach command yet",
    });

    await expectError(base, "/api/tasks/tnope9/diff", 404, "no such task: tnope9");
    const noDiffWorktree = makeTask();
    await expectError(base, `/api/tasks/${noDiffWorktree.id}/diff`, 409, "task has no worktree (failed before setup?)");
    const archivedDiff = makeTask();
    setTaskFields(archivedDiff.id, { archived: 1 });
    await expectError(base, `/api/tasks/${archivedDiff.id}/diff`, 409, "task is archived — worktree removed");

    const repo = makeRepo();
    const diffTask = makeTask({ repo_path: repo.path });
    setTaskFields(diffTask.id, { worktree_path: repo.path, branch: repo.branch, base_commit: repo.base });
    const diff = await api(base, `/api/tasks/${diffTask.id}/diff`);
    expect(diff.status).toBe(200);
    // `base` names the commit the daemon actually diffed from; this repo has no
    // remote, so it degrades to the task's own base_commit
    expect(await json(diff)).toEqual({
      diff: "",
      truncated: false,
      untracked: [],
      base: repo.base,
      worktreeReason: null,
    });
  });

  test("status reports live git rows and repos merge configured paths with history", async () => {
    const repo = makeRepo();
    const configured = mkdtempSync(join(tmpdir(), "wisp-configured-repo-"));
    const missing = join(configured, "does-not-exist");
    const base = await startServer([{ path: configured, name: "Configured" }, missing]);

    const live = makeTask({ repo_path: repo.path });
    setTaskFields(live.id, { worktree_path: repo.path, branch: repo.branch, base_commit: repo.base });
    const archived = makeTask({ repo_path: repo.path });
    setTaskFields(archived.id, { worktree_path: repo.path, branch: repo.branch, base_commit: repo.base, archived: 1 });

    const status = await api(base, "/api/status");
    expect(status.status).toBe(200);
    const statusBody = await json<{ tasks: Record<string, unknown> }>(status);
    expect(statusBody.tasks[live.id]).toEqual({
      branch: repo.branch,
      dirtyFiles: 0,
      ahead: 0,
      unpushed: false,
      worktreeReason: null,
    });
    expect(statusBody.tasks[archived.id]).toBeUndefined();

    const repos = await api(base, "/api/repos");
    expect(repos.status).toBe(200);
    const repoRows = await json<{ repos: Array<{ path: string; name: string | null; exists: boolean }> }>(repos);
    // every row carries its project config; a configured repo with no hooks
    // set reports them empty, and a task-history-only repo is `configured: false`
    expect(repoRows.repos.find((row) => row.path === configured)).toEqual({
      path: configured,
      name: "Configured",
      exists: true,
      setupScript: "",
      archiveScript: "",
      copyFiles: [],
      configured: true,
    });
    expect(repoRows.repos.find((row) => row.path === missing)).toEqual({
      path: missing,
      name: basename(missing),
      exists: false,
      setupScript: "",
      archiveScript: "",
      copyFiles: [],
      configured: true,
    });
    expect(repoRows.repos.find((row) => row.path === repo.path)).toEqual({
      path: repo.path,
      name: basename(repo.path),
      exists: true,
      setupScript: "",
      archiveScript: "",
      copyFiles: [],
      configured: false,
    });
  });

  test("harnesses expose builtin capabilities and never wait for model probes", async () => {
    const base = await startServer();
    const response = await api(base, "/api/harnesses");
    expect(response.status).toBe(200);
    const body = await json<{
      harnesses: Array<{
        name: string;
        hasModel: boolean;
        hasEffort: boolean;
        hasImage: boolean;
        imageNote?: string;
        effortLevels: string[];
        defaults: Record<string, string>;
        models: unknown;
        modelsError?: string;
      }>;
    }>(response);
    expect(body.harnesses.map((harness) => harness.name)).toEqual(["droid", "claude", "codex", "cursor"]);
    expect(body.harnesses.find((harness) => harness.name === "droid")).toMatchObject({
      hasModel: true,
      hasEffort: true,
      defaults: {},
      // A1c: droid HAS an image mechanism now (a path in the prompt), and the
      // caveat that mechanism carries travels with it as adapter-owned copy
      hasImage: true,
      imageNote:
        "this harness has no image flag: wisp names the file's path in the prompt and the harness reads it. png and jpeg only, and the prompt asks the model to say so if it cannot see the file.",
    });
    // the other two deliver by argv/stdin and have no such caveat to show
    for (const name of ["claude", "codex"]) {
      const entry = body.harnesses.find((harness) => harness.name === name)!;
      expect(entry.hasImage).toBe(true);
      expect(entry.imageNote).toBeUndefined();
    }
    // claude-code 2.1.246 gained --effort, so the adapter forwards it now
    expect(body.harnesses.find((harness) => harness.name === "claude")).toMatchObject({
      hasModel: true,
      hasEffort: true,
      defaults: {},
    });
    // the picker offers levels the CLI named, and they differ per harness
    expect(body.harnesses.find((harness) => harness.name === "claude")?.effortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(body.harnesses.find((harness) => harness.name === "droid")?.effortLevels).toContain("dynamic");
    // claude enumerates no models, so its curated list stands in for a probe
    // WITHOUT the endpoint having waited on one (this test asserts exactly
    // that: the response is served straight from the cold cache)
    expect(body.harnesses.find((harness) => harness.name === "claude")?.models).toMatchObject({
      list: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    });
    expect(body.harnesses.find((harness) => harness.name === "codex")).toMatchObject({
      hasModel: true,
      hasEffort: true,
      defaults: {},
    });
    // cursor (slice 9): a static owner-pinned list WITH an explicit default,
    // no effort flag (cursor's effort is a bracket override on the model id);
    // images by path delivery, live-verified 2026-08-31 on 2026.08.25 — the
    // shared strategy's generic note, same as droid's
    expect(body.harnesses.find((harness) => harness.name === "cursor")).toMatchObject({
      hasModel: true,
      hasEffort: false,
      hasImage: true,
      imageNote:
        "this harness has no image flag: wisp names the file's path in the prompt and the harness reads it. png and jpeg only, and the prompt asks the model to say so if it cannot see the file.",
      defaults: {},
      models: { list: ["cursor-grok-4.6-high", "composer-2.5"], defaultModel: "cursor-grok-4.6-high" },
      probeCommands: [],
      compact: null,
    });

    const cache = new ModelProbeCache(BUILTIN_ADAPTERS, {
      spawn: () => {
        throw new Error("probe failed");
      },
      timeoutMs: 100,
    });
    const url = new URL("http://wisp.test/api/harnesses");
    const before = await route(
      new Request(url, { headers: { authorization: `Bearer ${token}` } }),
      url,
      url.pathname,
      config(),
      BUILTIN_ADAPTERS,
      cache,
    );
    const unprobed = await json<{
      harnesses: Array<{ name: string; models: unknown; modelsError?: string }>;
    }>(before);
    for (const harness of unprobed.harnesses) {
      // claude and cursor have no probe to wait for (their CLIs enumerate
      // nothing wisp consumes — cursor's `agent models` needs auth and a
      // captured shape), so their curated staticModels lists stand in from
      // the very first request — that immediacy is the whole point of the
      // fallback. Every harness that IS probeable still reports null until
      // the probe lands.
      if (harness.name === "claude" || harness.name === "cursor") {
        expect(harness.models).not.toBeNull();
      } else {
        expect(harness.models).toBeNull();
      }
      expect(Object.hasOwn(harness, "modelsError")).toBe(false);
    }

    await cache.refresh();
    const after = await route(new Request(url), url, url.pathname, config(), BUILTIN_ADAPTERS, cache);
    const failed = await json<{ harnesses: Array<{ name: string; models: unknown; modelsError?: string }> }>(after);
    expect(failed.harnesses.find((harness) => harness.name === "droid")).toMatchObject({
      models: null,
      modelsError: "probe failed",
    });
    expect(failed.harnesses.find((harness) => harness.name === "codex")).toMatchObject({
      models: null,
      modelsError: "probe failed",
    });
  });

  test("task creation rejects missing fields, unknown harnesses, and unknown repositories verbatim", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-create-repo-"));
    const missingRepo = join(repo, "missing");
    const base = await startServer();

    await expectError(base, "/api/tasks", 400, "repoPath, prompt, and harness are required", "POST", {});
    await expectError(base, "/api/tasks", 400, "prompt must not be empty", "POST", {
      repoPath: repo,
      prompt: "",
      harness: "claude",
    });
    // type-checked at the boundary, never truthiness-checked: a non-string
    // used to sail past and 500 in launchTask — every one of these is a 400
    await expectError(base, "/api/tasks", 400, "repoPath must be a string, got number", "POST", {
      repoPath: 42,
      prompt: "make a task",
      harness: "claude",
    });
    await expectError(base, "/api/tasks", 400, "repoPath must be a string, got array", "POST", {
      repoPath: [repo],
      prompt: "make a task",
      harness: "claude",
    });
    await expectError(base, "/api/tasks", 400, "repoPath must be a string, got null", "POST", {
      repoPath: null,
      prompt: "make a task",
      harness: "claude",
    });
    await expectError(base, "/api/tasks", 400, "prompt must be a string, got number", "POST", {
      repoPath: repo,
      prompt: 42,
      harness: "claude",
    });
    await expectError(base, "/api/tasks", 400, "prompt must be a string, got array", "POST", {
      repoPath: repo,
      prompt: ["make a task"],
      harness: "claude",
    });
    await expectError(base, "/api/tasks", 400, "harness must be a string, got number", "POST", {
      repoPath: repo,
      prompt: "make a task",
      harness: 42,
    });
    await expectError(base, "/api/tasks", 400, "harness must be a string, got null", "POST", {
      repoPath: repo,
      prompt: "make a task",
      harness: null,
    });
    await expectError(
      base,
      "/api/tasks",
      400,
      "unknown harness 'bogus' (known: droid, claude, codex, cursor)",
      "POST",
      { repoPath: repo, prompt: "make a task", harness: "bogus" },
    );
    await expectError(
      base,
      "/api/tasks",
      400,
      `repoPath does not exist: ${missingRepo}`,
      "POST",
      { repoPath: missingRepo, prompt: "make a task", harness: "claude" },
    );
  });
});
