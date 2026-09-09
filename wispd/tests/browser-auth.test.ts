import { ownsHome } from "../src/home-lock";
/**
 * The browser's authentication boundary, exercised over real sockets against a
 * real listener (SEC-01 / SEC-02).
 *
 * A security review reproduced two things against this daemon: a cookie-only,
 * cross-origin `POST` that created state and returned `201`, and a terminal
 * WebSocket upgrade accepted with that same cookie and a foreign `Origin`. The
 * cookie's value was the root token. Both attacks are replayed here — one raw
 * request at a time, no browser required, because what is under test is what
 * the SERVER enforces.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import { killAll } from "../src/terminal";
import { createTask, freeSlot, newTaskId, setTaskFields } from "../src/store";

const TOKEN = "browser-auth-test-token";
/** The origin the attack comes from: another HTTP service on the very same host. */
const OTHER_LOCAL_PORT = "http://127.0.0.1:19999";

let server: Awaited<ReturnType<typeof serve>> | null = null;

/**
 * Shells are killed and awaited; the listener's shutdown deliberately is not.
 *
 * Several cases here make the daemon REFUSE a socket, which it does by closing
 * it — and in Bun 1.3.14 a server-initiated WebSocket close leaves
 * `server.stop()` pending forever (reproduced with a bare `Bun.serve`: a
 * `ws.close()` or `ws.terminate()` from a message handler never settles the
 * stop promise, while a client-initiated close settles it immediately).
 * Awaiting it would hang this file's teardown rather than test anything. Each
 * case binds its own ephemeral port, so a lingering listener collides with
 * nothing and the runner's exit reclaims it. Production never calls stop() —
 * the daemon runs until its process ends.
 */
afterEach(async () => {
  await killAll();
  void server?.stop(true);
  // Socket drain can hang in Bun, but the daemon's stateful shutdown must
  // finish before the next test takes ownership of this fixture home.
  const deadline = Date.now() + 5000;
  while (ownsHome() && Date.now() < deadline) await Bun.sleep(10);
  expect(ownsHome()).toBe(false);
  server = null;
}, 30_000);

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function writeConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 18710,
      host: "127.0.0.1",
      token: TOKEN,
      webhooks: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
}

/** A task with a real worktree, so a terminal upgrade would have a shell to spawn. */
function taskWithWorktree(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `wisp-browser-auth-${label}-`));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "browser-auth-test@wisp"]);
  git(repo, ["config", "user.name", "browser-auth-test"]);
  writeFileSync(join(repo, "README"), `${label}\n`);
  git(repo, ["add", "README"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const taskId = newTaskId();
  const branch = `wisp/${taskId}-browser-auth-${label}`;
  git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
  createTask({
    id: taskId,
    title: `browser auth ${label}`,
    repo_path: repo,
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(taskId, { worktree_path: worktree, branch, base_commit: git(repo, ["rev-parse", "HEAD"]) });
  return taskId;
}

/** The upgrade's outcome, without caring which frame arrived first. */
async function upgradeOutcome(
  url: string,
  options: { headers?: Record<string, string>; send?: unknown } = {},
): Promise<{ closed: number | null; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(url, { headers: options.headers ?? {} });
  const frames: Record<string, unknown>[] = [];
  return await new Promise((resolve) => {
    const finish = (closed: number | null): void => resolve({ closed, frames });
    const timer = setTimeout(() => {
      socket.close();
      finish(null);
    }, 2_000);
    socket.onopen = () => {
      if (options.send !== undefined) socket.send(JSON.stringify(options.send));
    };
    socket.onmessage = (event) => {
      try {
        frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        frames.push({ type: "unparsed", data: String(event.data) });
      }
      // `hello` means a shell exists; nothing more will change the verdict.
      if (frames.some((frame) => frame.type === "hello")) {
        clearTimeout(timer);
        socket.close();
        finish(null);
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      finish(event.code);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      finish(-1);
    };
  });
}

describe("SEC-02 — a cross-origin write with the retired cookie", () => {
  test("is refused before any state changes, and the bearer path still works", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    // The review's exact reproduction: a text/plain POST (no CORS preflight),
    // a foreign Origin, and the root token in a cookie. It answered 201.
    const forged = await fetch(`${base}/api/suffix-prompts`, {
      method: "POST",
      headers: {
        cookie: `wisp_token=${TOKEN}`,
        origin: OTHER_LOCAL_PORT,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ name: "forged", prompt: "forged" }),
    });
    expect(forged.status).toBe(401);

    // …and it created nothing.
    const listed = await fetch(`${base}/api/suffix-prompts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("forged");

    const real = await fetch(`${base}/api/suffix-prompts`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "real", prompt: "real" }),
    });
    expect(real.status).toBe(201);
  });

  test("a same-origin browser read with no credential is still unauthorized", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/api/outbox`, { headers: { origin: base } });
    expect(response.status).toBe(401);
  });
});

describe("SEC-02 — terminal WebSocket upgrades", () => {
  test("a foreign origin is refused, cookie or not", async () => {
    writeConfig();
    const taskId = taskWithWorktree("foreign");
    server = await serve({ port: 0 });
    const url = `ws://127.0.0.1:${server.port}/api/tasks/${taskId}/terminal`;

    for (const headers of [
      { origin: OTHER_LOCAL_PORT, cookie: `wisp_token=${TOKEN}` },
      { origin: OTHER_LOCAL_PORT },
      { origin: "null" },
      { origin: "https://attacker.example", authorization: `Bearer ${TOKEN}` },
    ]) {
      const outcome = await upgradeOutcome(url, { headers });
      expect(outcome.frames.some((frame) => frame.type === "hello")).toBe(false);
    }
  }, 20_000);

  test("a same-origin socket with no credential must authenticate before a shell exists", async () => {
    writeConfig();
    const taskId = taskWithWorktree("handshake");
    server = await serve({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    const url = `ws://127.0.0.1:${server.port}/api/tasks/${taskId}/terminal`;

    // Asked for, but never given: the socket opens, is told to authenticate,
    // and gets nothing.
    const unauthenticated = await upgradeOutcome(url, {
      headers: { origin },
      send: { type: "in", data: "echo escaped\n" },
    });
    expect(unauthenticated.frames[0]).toEqual({ type: "auth_required" });
    expect(unauthenticated.frames.some((frame) => frame.type === "hello")).toBe(false);
    expect(unauthenticated.closed).toBe(1008);

    // A wrong token closes the socket rather than inviting another guess.
    const wrong = await upgradeOutcome(url, {
      headers: { origin },
      send: { type: "auth", token: `${TOKEN}x` },
    });
    expect(wrong.frames.some((frame) => frame.type === "hello")).toBe(false);
    expect(wrong.closed).toBe(1008);

    // The real token attaches, and only then.
    const authenticated = await upgradeOutcome(url, {
      headers: { origin },
      send: { type: "auth", token: TOKEN },
    });
    expect(authenticated.frames.some((frame) => frame.type === "hello")).toBe(true);
  }, 30_000);

  test("a bearer upgrade attaches immediately, with no handshake frame", async () => {
    writeConfig();
    const taskId = taskWithWorktree("bearer");
    server = await serve({ port: 0 });
    const outcome = await upgradeOutcome(`ws://127.0.0.1:${server.port}/api/tasks/${taskId}/terminal`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outcome.frames.some((frame) => frame.type === "auth_required")).toBe(false);
    expect(outcome.frames.some((frame) => frame.type === "hello")).toBe(true);
  }, 20_000);

  test("no credential and no origin is a plain 401, not an upgrade", async () => {
    writeConfig();
    const taskId = taskWithWorktree("anonymous");
    server = await serve({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${taskId}/terminal`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    expect(response.status).toBe(401);
  });

  /**
   * An unauthenticated upgrade may not answer "does this task exist?" — that
   * question is an oracle for anyone who can reach the port, and a forged
   * Origin header costs an attacker nothing outside a browser.
   */
  test("an unauthenticated upgrade reveals nothing about which tasks exist", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    const missing = await upgradeOutcome(`ws://127.0.0.1:${server.port}/api/tasks/tnothere/terminal`, {
      headers: { origin },
    });
    expect(missing.frames[0]).toEqual({ type: "auth_required" });

    const bearer = await fetch(`http://127.0.0.1:${server.port}/api/tasks/tnothere/terminal`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(404);
  }, 20_000);
});
