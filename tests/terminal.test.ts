import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH } from "../src/config";
import { parseTerminalSize, serve } from "../src/daemon";
import {
  DEFAULT_PTY_SIZE,
  DISPLACED_MESSAGE,
  killAll,
  killForTask,
  loginShell,
  loginShellArgv,
  sessionKey,
  WEB_TERMINAL_TERM,
  webTerminalEnv,
} from "../src/terminal";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";

const token = "terminal-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function waitFor<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`terminal test timed out after ${ms}ms`);
    }),
  ]);
}

afterEach(async () => {
  await killAll();
  if (server) await server.stop(true);
  server = null;
});

describe("embedded web terminal", () => {
  test("runs in the worktree and archive kills the attached shell", async () => {
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

    const root = mkdtempSync(join(tmpdir(), "wisp-terminal-test-"));
    const repo = join(root, "repo");
    const worktree = join(root, "worktree");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "terminal-test@wisp"]);
    git(repo, ["config", "user.name", "terminal-test"]);
    writeFileSync(join(repo, "README"), "terminal test\n");
    git(repo, ["add", "README"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const taskId = newTaskId();
    const branch = `wisp/${taskId}-terminal-test`;
    git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
    const task = createTask({
      id: taskId,
      title: "terminal test",
      repo_path: repo,
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, {
      worktree_path: worktree,
      branch,
      base_commit: git(repo, ["rev-parse", "HEAD"]),
    });

    server = await serve({ port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const messages: Array<Record<string, unknown>> = [];
    let sentInput = false;
    let resolveOutput!: () => void;
    let rejectOutput!: (error: Error) => void;
    let resolveExit!: (message: Record<string, unknown>) => void;
    let rejectExit!: (error: Error) => void;
    const output = new Promise<void>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    const exit = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    ws.onerror = () => {
      const error = new Error("terminal websocket error");
      rejectOutput(error);
      rejectExit(error);
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "hello" && !sentInput) {
        expect(message.pty).toBe(true);
        expect(message.cwd).toBe(worktree);
        sentInput = true;
        ws.send(JSON.stringify({ type: "in", data: "echo wisp-terminal-ok\n" }));
      }
      if (message.type === "out" && String(message.data).includes("wisp-terminal-ok")) resolveOutput();
      if (message.type === "exit") resolveExit(message);
    };

    await waitFor(output, 10_000);
    const archive = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${task.id}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(archive.status).toBe(200);
    const exitMessage = await waitFor(exit, 10_000);
    expect(exitMessage.type).toBe("exit");
    expect(getTask(task.id)!.archived).toBe(1);
    expect(messages.some((message) => message.type === "hello")).toBe(true);
    ws.close();
  });

  test(
    "respawns a fresh shell when the previous shell has exited",
    { timeout: 20_000 },
    async () => {
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

      const root = mkdtempSync(join(tmpdir(), "wisp-terminal-respawn-test-"));
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      mkdirSync(repo);
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "terminal-test@wisp"]);
      git(repo, ["config", "user.name", "terminal-test"]);
      writeFileSync(join(repo, "README"), "terminal respawn test\n");
      git(repo, ["add", "README"]);
      git(repo, ["commit", "-q", "-m", "init"]);

      const taskId = newTaskId();
      const branch = `wisp/${taskId}-terminal-respawn`;
      git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
      const task = createTask({
        id: taskId,
        title: "terminal respawn test",
        repo_path: repo,
        harness: "fake",
        model: null,
        slot: freeSlot(),
      });
      setTaskFields(task.id, {
        worktree_path: worktree,
        branch,
        base_commit: git(repo, ["rev-parse", "HEAD"]),
      });

      server = await serve({ port: 0 });
      const first = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const firstHello = new Promise<void>((resolve, reject) => {
        first.onerror = () => reject(new Error("first terminal websocket error"));
        first.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "hello") resolve();
        };
      });
      await waitFor(firstHello, 10_000);
      await killForTask(task.id);
      first.close();

      const second = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const reattachedOutput = new Promise<void>((resolve, reject) => {
        second.onerror = () => reject(new Error("reattached terminal websocket error"));
        second.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "hello") {
            expect(message.cwd).toBe(worktree);
            second.send(JSON.stringify({ type: "in", data: "echo respawned-shell\n" }));
          }
          if (message.type === "out" && String(message.data).includes("respawned-shell")) resolve();
        };
      });
      await waitFor(reattachedOutput, 10_000);
      second.close();
    },
  );

  test(
    "a reattaching tab replays its shell's scrollback, and tabs are separate shells",
    { timeout: 30_000 },
    async () => {
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

      const root = mkdtempSync(join(tmpdir(), "wisp-terminal-replay-test-"));
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      mkdirSync(repo);
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "terminal-test@wisp"]);
      git(repo, ["config", "user.name", "terminal-test"]);
      writeFileSync(join(repo, "README"), "terminal replay test\n");
      git(repo, ["add", "README"]);
      git(repo, ["commit", "-q", "-m", "init"]);

      const taskId = newTaskId();
      const branch = `wisp/${taskId}-terminal-replay`;
      git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
      const task = createTask({
        id: taskId,
        title: "terminal replay test",
        repo_path: repo,
        harness: "fake",
        model: null,
        slot: freeSlot(),
      });
      setTaskFields(task.id, {
        worktree_path: worktree,
        branch,
        base_commit: git(repo, ["rev-parse", "HEAD"]),
      });

      server = await serve({ port: 0 });
      const url = (shell: number): string =>
        `ws://127.0.0.1:${server!.port}/api/tasks/${task.id}/terminal?shell=${shell}`;

      /** Attach, run `input` if given, and resolve with the hello frame's replay. */
      const attach = (shell: number, input?: string, awaitOutput?: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const ws = new WebSocket(url(shell), { headers: { authorization: `Bearer ${token}` } });
          let replay = "";
          ws.onerror = () => reject(new Error(`terminal websocket error on shell ${shell}`));
          ws.onmessage = (event) => {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message.type === "hello") {
              replay = String(message.replay ?? "");
              if (input) ws.send(JSON.stringify({ type: "in", data: input }));
              else {
                ws.close();
                resolve(replay);
              }
            }
            if (awaitOutput && message.type === "out" && String(message.data).includes(awaitOutput)) {
              ws.close();
              resolve(replay);
            }
          };
        });

      // first attach: nothing has been printed yet, so nothing to replay
      const firstReplay = await waitFor(attach(0, "echo scrollback-marker\n", "scrollback-marker"), 15_000);
      expect(firstReplay).toBe("");

      // reattach the SAME tab: the shell is still alive and its output comes back
      const secondReplay = await waitFor(attach(0), 15_000);
      expect(secondReplay).toContain("scrollback-marker");

      // a DIFFERENT tab is a different shell — it must not inherit that output
      const otherTab = await waitFor(attach(1), 15_000);
      expect(otherTab).not.toContain("scrollback-marker");
    },
  );

  /**
   * Opening one task in a browser and in the desktop app at the same time.
   * The daemon keeps ONE attachment per shell, so the second arrival takes it
   * — and used to take it in silence: the displaced socket stayed open, kept
   * its screen, and had every keystroke dropped with the explaining error
   * suppressed on the way out. A terminal that ignores you has to say so.
   */
  test(
    "a second client takes the shell and the first is told, not silenced",
    { timeout: 30_000 },
    async () => {
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

      const root = mkdtempSync(join(tmpdir(), "wisp-terminal-displace-test-"));
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      mkdirSync(repo);
      git(repo, ["init", "-q"]);
      git(repo, ["config", "user.email", "terminal-test@wisp"]);
      git(repo, ["config", "user.name", "terminal-test"]);
      writeFileSync(join(repo, "README"), "terminal displacement test\n");
      git(repo, ["add", "README"]);
      git(repo, ["commit", "-q", "-m", "init"]);

      const taskId = newTaskId();
      const branch = `wisp/${taskId}-terminal-displace`;
      git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
      const task = createTask({
        id: taskId,
        title: "terminal displacement test",
        repo_path: repo,
        harness: "fake",
        model: null,
        slot: freeSlot(),
      });
      setTaskFields(task.id, {
        worktree_path: worktree,
        branch,
        base_commit: git(repo, ["rev-parse", "HEAD"]),
      });

      server = await serve({ port: 0 });
      const url = `ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal?shell=0`;

      const errors: string[] = [];
      const first = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      const firstHello = new Promise<void>((resolve, reject) => {
        first.onerror = () => reject(new Error("first terminal websocket error"));
        first.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "hello") resolve();
          if (message.type === "error") errors.push(String(message.message));
        };
      });
      await waitFor(firstHello, 10_000);

      const displaced = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (errors.length > 0) {
            clearInterval(poll);
            resolve();
          }
        }, 25);
      });

      const second = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      const secondHello = new Promise<void>((resolve, reject) => {
        second.onerror = () => reject(new Error("second terminal websocket error"));
        second.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === "hello") resolve();
        };
      });
      await waitFor(secondHello, 10_000);
      await waitFor(displaced, 10_000);

      expect(errors).toEqual([DISPLACED_MESSAGE]);
      // and the first socket is still open, so its `retry` can take it back
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.close();
      second.close();
    },
  );

  test("rejects a shell id outside the per-task range instead of upgrading", async () => {
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

    const root = mkdtempSync(join(tmpdir(), "wisp-terminal-shellid-test-"));
    const repo = join(root, "repo");
    const worktree = join(root, "worktree");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "terminal-test@wisp"]);
    git(repo, ["config", "user.name", "terminal-test"]);
    writeFileSync(join(repo, "README"), "terminal shell id test\n");
    git(repo, ["add", "README"]);
    git(repo, ["commit", "-q", "-m", "init"]);

    const taskId = newTaskId();
    const branch = `wisp/${taskId}-terminal-shellid`;
    git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
    const task = createTask({
      id: taskId,
      title: "terminal shell id test",
      repo_path: repo,
      harness: "fake",
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, { worktree_path: worktree, branch, base_commit: git(repo, ["rev-parse", "HEAD"]) });

    server = await serve({ port: 0 });
    const base = `http://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal`;
    const headers = { authorization: `Bearer ${token}` };
    for (const bad of ["99", "-1", "1.5", "abc"]) {
      const response = await fetch(`${base}?shell=${bad}`, { headers });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("shell must be an integer");
    }
  });
});

describe("loginShell + shell argv", () => {
  test("the browser shell always gets xterm capabilities", () => {
    expect(webTerminalEnv({}, {})).toMatchObject({
      TERM: WEB_TERMINAL_TERM,
      COLORTERM: "truecolor",
    });
    expect(webTerminalEnv({ TERM: "dumb", COLORTERM: "0" }, { TERM: "vt100" })).toMatchObject({
      TERM: WEB_TERMINAL_TERM,
      COLORTERM: "truecolor",
    });
  });

  test("drops an inherited COLUMNS/LINES so the tty stays authoritative", () => {
    // The daemon may have been started from a terminal. Those values describe
    // that window, and a shell startup file reading them would size the prompt
    // for it instead of for the pane the pty was just sized to.
    const env = webTerminalEnv({ COLUMNS: "204", LINES: "51" }, {});
    expect(env.COLUMNS).toBeUndefined();
    expect(env.LINES).toBeUndefined();
  });

  test("prefers $SHELL when it points at an existing binary", () => {
    const orig = process.env.SHELL;
    const shell = Bun.which("sh");
    if (!shell) throw new Error("test requires sh on PATH");
    process.env.SHELL = shell;
    try {
      expect(loginShell()).toBe(shell);
      expect(loginShellArgv()).toEqual([shell, "-l"]);
    } finally {
      if (orig === undefined) delete process.env.SHELL;
      else process.env.SHELL = orig;
    }
  });

  test("a $SHELL that does not exist falls back to the platform default", () => {
    const orig = process.env.SHELL;
    process.env.SHELL = "/nonexistent/noshell";
    try {
      expect(loginShell()).toBe(process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    } finally {
      if (orig === undefined) delete process.env.SHELL;
      else process.env.SHELL = orig;
    }
  });
});

describe("terminal size on the upgrade", () => {
  test("takes the pane's measured geometry", () => {
    expect(parseTerminalSize(new URLSearchParams("shell=0&cols=58&rows=9"))).toEqual({ cols: 58, rows: 9 });
  });

  test("a client that did not measure itself gets the documented default", () => {
    expect(parseTerminalSize(new URLSearchParams("shell=0"))).toBeNull();
    expect(DEFAULT_PTY_SIZE).toEqual({ cols: 80, rows: 24 });
  });

  test("rejects a garbled size instead of quietly inventing one", () => {
    for (const query of ["cols=0&rows=9", "cols=58&rows=0", "cols=abc&rows=9", "cols=58", "cols=1001&rows=9"]) {
      expect(typeof parseTerminalSize(new URLSearchParams(query))).toBe("string");
    }
  });
});

describe("sessionKey", () => {
  test("names one shell per (task, tab), so tabs are separate processes", () => {
    expect(sessionKey("tabc", 0)).toBe("tabc:0");
    expect(sessionKey("tabc", 3)).toBe("tabc:3");
    expect(sessionKey("tabc", 0)).not.toBe(sessionKey("tdef", 0));
  });
});
