import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, LOG_DIR, type WispConfig } from "../src/config";
import { BUILTIN_ADAPTERS, type AdapterDef } from "../src/adapters";
import { route, serve } from "../src/daemon";
import {
  createTask,
  createTurn,
  db,
  finishTurn,
  freeSlot,
  getTask,
  newTaskId,
  setTaskFields,
  transition,
  turnsFor,
} from "../src/store";
import { createSuffixPrompt, SUFFIX_PROMPT_SEPARATOR } from "../src/suffix-prompts";
import { taskMode } from "../src/types";

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

function writeConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 18710,
      host: "127.0.0.1",
      token,
      webhooks: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
}

const BUNDLE_PATH = join(import.meta.dir, "../web/ui-dist/index.html");

describe("the web app", () => {
  test("GET / serves the committed single-file bundle, embedded in the binary", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    // byte-for-byte the committed artifact — it reaches the daemon through a
    // text import, so a stale ui-dist would ship silently without this
    expect(html).toBe(await Bun.file(BUNDLE_PATH).text());
    expect(html).toContain('id="root"');
  });

  test("/index.html is the same page, and nothing else is served off the API", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/index.html`)).status).toBe(200);
    // the old page and its vendored assets are gone; the app inlines xterm
    for (const path of ["/app", "/vendor/xterm.js", "/vendor/xterm.css", "/vendor/addon-fit.js"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });

  /**
   * The daemon serves ONE file and no assets, so the bundle has to be truly
   * self-contained: a CDN reference or an un-inlined chunk would 404 in the
   * browser and there is no static handler left to catch it.
   */
  test("the bundle is self-contained — one file, nothing external", async () => {
    const html = await Bun.file(BUNDLE_PATH).text();
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    expect(html).not.toContain("@import");
    // No tag may FETCH anything: singlefile inlines scripts and styles, so a
    // surviving src=/href= is an un-inlined chunk. Asserted on the document
    // head only — the inlined bundle is minified JS full of strings that look
    // like markup, and regexing that is how you get a false positive.
    //
    // `data:` is exempt because it is the opposite of a fetch: the favicon is
    // carried in the attribute precisely BECAUSE there is no asset route to
    // serve it from. The rule is "nothing leaves the document", not "no href".
    const head = html.slice(0, html.indexOf("<script"));
    expect(head).not.toMatch(/<(?:script|link|img)[^>]*\s(?:src|href)="(?!data:)/);

    // and the build really emitted a single artifact
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(import.meta.dir, "../web/ui-dist"))).toEqual(["index.html"]);
  });

  /**
   * The favicon is generated into web/ui/index.html by scripts/brand/build.ts,
   * so it can drift from brand/favicon.svg the same way ui-dist drifts from
   * web/ui — by someone hand-editing one of the two. Same defect, same fix:
   * assert the shipped bytes against the source of truth.
   */
  test("the served favicon is the committed brand mark", async () => {
    const html = await Bun.file(BUNDLE_PATH).text();
    const href = /<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/.exec(html);
    expect(href).not.toBeNull();

    const { faviconDataUri } = await import("../scripts/brand/mark");
    const brandSvg = await Bun.file(join(import.meta.dir, "../brand/favicon.svg")).text();
    expect(href![1]).toBe(faviconDataUri(brandSvg));

    // and the theme colour matches the app's --background
    expect(html).toContain('<meta name="theme-color" content="#0b0b0d" />');
  });
});

/** Bearer-authed fetch against the sandbox daemon (the CLI path; cookie minting is covered in stream.test.ts). */
function auth(): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Read an SSE body until `needle` shows up or the deadline passes; fails loudly on timeout. */
async function readStreamUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 5_000): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (!buf.includes(needle) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  if (!buf.includes(needle)) throw new Error(`timed out waiting for ${needle} (buffered: ${JSON.stringify(buf)})`);
  return buf;
}

describe("S1 create-modal and project APIs", () => {
  test("task effort is explicit-over-config, persisted, and unsupported effort is rejected", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-web-effort-"));
    const cfg: WispConfig = {
      port: 18710,
      host: "127.0.0.1",
      token,
      webhooks: [],
      repos: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {
        droid: { model: "kimi-k3", reasoningEffort: "low" },
        plain: { reasoningEffort: "high" },
      },
    };
    // claude-code 2.1.246 gained --effort, so every builtin now supports
    // effort — the rejection path needs a synthetic adapter to stay covered.
    const plain: AdapterDef = { ...BUILTIN_ADAPTERS.claude!, effort: undefined, effortLevels: undefined };
    const adapters = { droid: BUILTIN_ADAPTERS.droid, claude: BUILTIN_ADAPTERS.claude, plain };
    const call = async (body: unknown): Promise<Response> => {
      const url = new URL("http://wisp.test/api/tasks");
      return await route(
        new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        url,
        url.pathname,
        cfg,
        adapters,
      );
    };

    const explicit = await call({ repoPath: repo, prompt: "explicit", harness: "droid", effort: "high" });
    expect(explicit.status).toBe(201);
    const explicitTask = (await explicit.json()) as { id: string; effort: string | null };
    expect(explicitTask.effort).toBe("high");

    const configured = await call({ repoPath: repo, prompt: "configured", harness: "droid" });
    expect(configured.status).toBe(201);
    expect(((await configured.json()) as { effort: string | null }).effort).toBe("low");

    // claude accepts an effort now rather than 400-ing on it
    const claudeEffort = await call({ repoPath: repo, prompt: "claude effort", harness: "claude", effort: "xhigh" });
    expect(claudeEffort.status).toBe(201);
    expect(((await claudeEffort.json()) as { effort: string | null }).effort).toBe("xhigh");

    const unsupported = await call({ repoPath: repo, prompt: "unsupported", harness: "plain", effort: "high" });
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { error: string }).error).toBe("harness 'plain' has no effort support");

    const unsupportedDefault = await call({ repoPath: repo, prompt: "unsupported default", harness: "plain" });
    expect(unsupportedDefault.status).toBe(400);
    expect(((await unsupportedDefault.json()) as { error: string }).error).toBe("harness 'plain' has no effort support");
  });

  test("projects round-trip through the API, preserve unknown config keys, and update names idempotently", async () => {
    const first = mkdtempSync(join(tmpdir(), "wisp-web-project-"));
    const historical = mkdtempSync(join(tmpdir(), "wisp-web-history-"));
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        port: 18710,
        host: "127.0.0.1",
        token,
        repos: [first],
        unknownFutureSetting: { keep: true },
        webhooks: [],
        stuckMinutes: 10,
        logMaxBytes: 5_000_000,
        setupTimeoutMinutes: 10,
        envAllowlist: {},
        harnessDefaults: {},
      }),
    );
    server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("missing probe binary"); } });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (body: unknown) =>
      fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const add = await post({ path: `${first}/.`, name: "First" });
    expect(add.status).toBe(200); // the legacy string entry is updated in place
    expect(((await add.json()) as { name: string }).name).toBe("First");
    const update = await post({ path: first, name: "Renamed" });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { name: string }).name).toBe("Renamed");

    const listed = (await (await fetch(`${base}/api/repos`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      repos: { path: string; name: string | null; exists: boolean }[];
    };
    const row = listed.repos.find((repo) => repo.path === first);
    // the row now carries the project's hooks; unset ones come back empty
    expect(row).toEqual({
      path: first,
      name: "Renamed",
      exists: true,
      setupScript: "",
      archiveScript: "",
      copyFiles: [],
      configured: true,
    });

    const task = createTask({
      id: newTaskId(),
      title: "history only",
      repo_path: historical,
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { archived: 1 });
    const historyDelete = await fetch(`${base}/api/projects`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: historical }),
    });
    expect(historyDelete.status).toBe(404);
    expect(((await historyDelete.json()) as { error: string }).error).toContain("only in task history");

    const remove = await fetch(`${base}/api/projects`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: first }),
    });
    expect(remove.status).toBe(200);
    const after = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
    expect(after.unknownFutureSetting).toEqual({ keep: true });
    expect(after.repos).toEqual([]);
  });

  /**
   * The settings modal saves one section at a time, so every field is PATCH:
   * omitting it preserves what is stored, and an explicit ""/[] clears it.
   * Anything else would blank the two fields the user was not editing.
   */
  test("project hooks patch independently and clear only when explicitly emptied", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-hooks-"));
    writeConfig();
    server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("missing probe binary"); } });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (body: unknown) =>
      fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    type Row = { setupScript: string; archiveScript: string; copyFiles: string[]; name?: string };

    const created = (await (await post({ path: repo, setupScript: "pnpm install" })).json()) as Row;
    expect(created.setupScript).toBe("pnpm install");
    expect(created.copyFiles).toEqual([]);

    // a name-only save must not wipe the script that was already there
    const named = (await (await post({ path: repo, name: "Hooked" })).json()) as Row;
    expect(named.name).toBe("Hooked");
    expect(named.setupScript).toBe("pnpm install");

    const withRest = (await (
      await post({ path: repo, archiveScript: "rm -rf node_modules", copyFiles: [".env*", "  ", "config/local.json"] })
    ).json()) as Row;
    expect(withRest.setupScript).toBe("pnpm install"); // still preserved
    expect(withRest.archiveScript).toBe("rm -rf node_modules");
    expect(withRest.copyFiles).toEqual([".env*", "config/local.json"]); // blank lines dropped

    const cleared = (await (await post({ path: repo, setupScript: "" })).json()) as Row;
    expect(cleared.setupScript).toBe("");
    expect(cleared.archiveScript).toBe("rm -rf node_modules"); // untouched by the clear

    // and it all survives a reload from disk
    const onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { repos: Array<Record<string, unknown>> };
    expect(onDisk.repos[0]).toMatchObject({ name: "Hooked", archiveScript: "rm -rf node_modules" });
    expect(onDisk.repos[0]!.setupScript).toBeUndefined();
  });

  test("copy-preview resolves the globs against the real repo before a task depends on them", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-preview-"));
    writeFileSync(join(repo, ".env"), "A=1\n");
    mkdirSync(join(repo, "backend"), { recursive: true });
    writeFileSync(join(repo, "backend", ".env"), "B=2\n");
    writeConfig();
    server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("missing probe binary"); } });
    const base = `http://127.0.0.1:${server.port}`;
    const preview = (body: unknown) =>
      fetch(`${base}/api/projects/copy-preview`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await preview({ path: repo, patterns: [".env*"] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { files: string[] }).files).toEqual([".env", "backend/.env"]);

    const empty = await preview({ path: repo, patterns: ["nothing-matches-*"] });
    expect(((await empty.json()) as { files: string[] }).files).toEqual([]);

    const badPath = await preview({ path: join(repo, "nope"), patterns: ["*"] });
    expect(badPath.status).toBe(400);
    expect(((await badPath.json()) as { error: string }).error).toContain("not an existing directory");

    const badPatterns = await preview({ path: repo, patterns: "just-a-string" });
    expect(badPatterns.status).toBe(400);
    expect(((await badPatterns.json()) as { error: string }).error).toContain("patterns must be an array of strings");
  });
});

/**
 * local mode. The property that matters is the negative one: archiving a local
 * task must never touch the user's checkout, because "worktree_path" for a
 * local task IS their working copy.
 */
describe("local vs worktree tasks", () => {
  function gitRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "wisp-local-"));
    const sh = (cmd: string[]): void => {
      const p = Bun.spawnSync({ cmd, cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
    };
    sh(["git", "init", "-q"]);
    writeFileSync(join(repo, "README.md"), "hi\n");
    sh(["git", "add", "."]);
    sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    return repo;
  }

  // A create that gets past validation LAUNCHES: real repo -> real worktree ->
  // real spawn. Anything asserting a 201 therefore runs on a harness that is
  // `true`, so no test can ever invoke an actual agent CLI.
  const FAKE_HARNESS: AdapterDef = { bin: "true", exec: [], parse: { format: "text" } };

  const cfg = (): WispConfig => ({
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
  });

  const call = async (path: string, method: string, body?: unknown): Promise<Response> => {
    const url = new URL(`http://wisp.test${path}`);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    return await route(new Request(url, init), url, url.pathname, cfg(), {
      droid: BUILTIN_ADAPTERS.droid!,
      fake: FAKE_HARNESS,
    });
  };

  test("an unknown mode is rejected by name, before any task row exists", async () => {
    const repo = gitRepo();
    const res = await call("/api/tasks", "POST", { repoPath: repo, prompt: "p", harness: "droid", mode: "sideways" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('mode must be one of worktree, local, got "sideways"');
  });

  test("suffix prompts reach create and steer turns while the task title stays user-authored", async () => {
    const repo = gitRepo();
    const createSuffix = createSuffixPrompt(`Review ${crypto.randomUUID()}`, "Inspect correctness and security.");
    const created = await call("/api/tasks", "POST", {
      repoPath: repo,
      prompt: "Review this PR",
      harness: "fake",
      suffixPromptId: createSuffix.id,
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; title: string };
    expect(task.title).toBe("Review this PR");

    const waitForTurns = async (count: number): Promise<ReturnType<typeof turnsFor>> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const turns = turnsFor(task.id);
        if (turns.length >= count && turns.every((turn) => turn.status !== "running")) return turns;
        if (Date.now() >= deadline) throw new Error(`task ${task.id} did not finish ${count} turns`);
        await Bun.sleep(20);
      }
    };

    const first = await waitForTurns(1);
    expect(first[0]?.prompt).toBe(
      `Review this PR${SUFFIX_PROMPT_SEPARATOR}Inspect correctness and security.`,
    );

    const steerSuffix = createSuffixPrompt(`Review loop ${crypto.randomUUID()}`, "Review, fix, and repeat.");
    const sent = await call(`/api/tasks/${task.id}/send`, "POST", {
      message: "Now review the implementation",
      suffixPromptId: steerSuffix.id,
    });
    expect(sent.status).toBe(200);
    const turns = await waitForTurns(2);
    expect(turns[1]?.prompt).toBe(
      `Now review the implementation${SUFFIX_PROMPT_SEPARATOR}Review, fix, and repeat.`,
    );
  });

  test("an unknown suffix prompt is rejected before task creation", async () => {
    const repo = gitRepo();
    const res = await call("/api/tasks", "POST", {
      repoPath: repo,
      prompt: "Review this PR",
      harness: "fake",
      suffixPromptId: "missing",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown suffixPromptId 'missing'" });
  });

  test("a second live local task in the same repo is refused, naming the first", async () => {
    const repo = gitRepo();
    const existing = createTask({
      id: newTaskId(),
      title: "already local",
      repo_path: repo,
      harness: "droid",
      model: null,
      mode: "local",
      slot: freeSlot(),
    });
    const res = await call("/api/tasks", "POST", { repoPath: repo, prompt: "p", harness: "droid", mode: "local" });
    expect(res.status).toBe(409);
    const message = ((await res.json()) as { error: string }).error;
    expect(message).toContain(existing.id);
    expect(message).toContain("archive it first");
    // the same repo takes as many WORKTREE tasks as you like — they are isolated
    const worktreeTask = await call("/api/tasks", "POST", { repoPath: repo, prompt: "p", harness: "fake" });
    expect(worktreeTask.status).toBe(201);
  });

  test("archiving a local task leaves the checkout completely alone", async () => {
    const repo = gitRepo();
    const task = createTask({
      id: newTaskId(),
      title: "local task",
      repo_path: repo,
      harness: "droid",
      model: null,
      mode: "local",
      slot: freeSlot(),
    });
    // launchTask records the checkout itself as the worktree
    setTaskFields(task.id, { worktree_path: repo, branch: "main", base_commit: null });

    const res = await call(`/api/tasks/${task.id}/archive`, "POST", {});
    expect(res.status).toBe(200);
    // THE point of local mode: the directory and its git dir both survive
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(getTask(task.id)!.archived).toBe(1);
  });

  test("mode round-trips through the API as a task field", async () => {
    const repo = gitRepo();
    const local = createTask({
      id: newTaskId(),
      title: "local",
      repo_path: repo,
      harness: "droid",
      model: null,
      mode: "local",
      slot: freeSlot(),
    });
    const res = await call(`/api/tasks/${local.id}`, "GET");
    expect(((await res.json()) as { mode: string }).mode).toBe("local");
  });

  test("a row written before the column existed reads as a worktree task", () => {
    const legacy = createTask({
      id: newTaskId(),
      title: "legacy",
      repo_path: "/tmp/whatever",
      harness: "droid",
      model: null,
      slot: freeSlot(),
    });
    db.run(`UPDATE tasks SET mode = NULL WHERE id = ?`, [legacy.id]);
    expect(taskMode(getTask(legacy.id)!)).toBe("worktree");
  });
});

describe("the archived-tasks view", () => {
  test("?archived=1 surfaces archived tasks, and an archived task stays readable but read-only", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    // a finished task with a real log file in LOG_DIR, then archived
    const task = createTask({
      id: newTaskId(),
      title: "archived probe",
      repo_path: "/tmp/repo",
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    const logFile = join(LOG_DIR, `${task.id}-turn1.out.log`);
    writeFileSync(logFile, "first line\nsecond line\n");
    const turnId = createTurn(task.id, 1, "do the probe", null, logFile);
    finishTurn(turnId, "done", 0, "probe done");
    transition(task.id, "done", "probe done");
    setTaskFields(task.id, { archived: 1 });

    // the sidebar section's data: hidden by default, present and flagged with ?archived=1
    const def = (await (await fetch(`${base}/api/tasks`, auth())).json()) as { id: string }[];
    expect(def.some((t) => t.id === task.id)).toBe(false);
    const all = (await (await fetch(`${base}/api/tasks?archived=1`, auth())).json()) as { id: string; archived: boolean }[];
    const row = all.find((t) => t.id === task.id);
    expect(row?.archived).toBe(true);

    // the read-only view's content: detail still returns the stored conversation
    const det = (await (
      await fetch(`${base}/api/tasks/${task.id}`, auth())
    ).json()) as { archived: boolean; turns: { prompt: string; result: string | null }[] };
    expect(det.archived).toBe(true);
    expect(det.turns[0]?.prompt).toBe("do the probe");
    expect(det.turns[0]?.result).toBe("probe done");

    // the log stream survives archive (logs live outside the worktree), so the
    // stream pane is reused as-is — this is the contract the UI depends on
    const res = await fetch(`${base}/api/tasks/${task.id}/log/stream?format=raw`, auth());
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const buf = await readStreamUntil(reader, "event: turn-end");
      expect(buf).toContain("event: backlog");
      expect(buf).toContain(`"prompt":"do the probe"`);
      expect(buf).toContain("first line");
      expect(buf).toContain(`"status":"done"`);
    } finally {
      await reader.cancel();
    }

    // steer and diff refuse honestly — the UI hides both before ever calling
    const send = await fetch(`${base}/api/tasks/${task.id}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(send.status).toBe(409);
    expect(((await send.json()) as { error: string }).error).toContain("archived");
    const diff = await fetch(`${base}/api/tasks/${task.id}/diff`, auth());
    expect(diff.status).toBe(409);
    expect(((await diff.json()) as { error: string }).error).toContain("archived");
  });

  test("archiving emits a task event on /api/events, so the sidebar moves the task live", async () => {
    // route() directly, the stream.test.ts pattern: a real-socket fetch of an
    // SSE endpoint that stays silent until the first event races Bun's fetch
    const cfg: WispConfig = {
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
    const call = (path: string, init?: RequestInit): Response | Promise<Response> => {
      const url = new URL(`http://wisp.test${path}`);
      return route(new Request(url, init), url, url.pathname, cfg, {});
    };

    // repo_path must exist (the archive endpoint prunes in it); the worktree dir is already gone
    const repo = mkdtempSync(join(tmpdir(), "wisp-web-arch-"));
    const task = createTask({
      id: newTaskId(),
      title: "archive me",
      repo_path: repo,
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    transition(task.id, "done", "wrapped");
    setTaskFields(task.id, { worktree_path: join(repo, ".gone"), branch: "wisp/probe" });

    const events = await call("/api/events");
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    try {
      const res = await call(`/api/tasks/${task.id}/archive`, { method: "POST" });
      expect(res.status).toBe(200);
      const buf = await readStreamUntil(reader, `"taskId":"${task.id}"`);
      expect(buf).toContain(`"type":"task"`);
      // not a state transition: the row's state rides along unchanged
      expect(buf).toContain(`"state":"done"`);
    } finally {
      await reader.cancel();
    }
  });
});
