import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import {
  darwinPtyArgv,
  killAll,
  killForTask,
  linuxPtyArgv,
  loginShell,
  parseTty,
  ReplayBuffer,
  resizePty,
  sessionKey,
  sttyResizeArgv,
  ttyForPidArgv,
  WEB_TERMINAL_TERM,
  webTerminalEnv,
  type TerminalSpawnFn,
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

describe("loginShell + PTY argv", () => {
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

  test("prefers $SHELL when it points at an existing binary", () => {
    const orig = process.env.SHELL;
    const shell = Bun.which("sh");
    if (!shell) throw new Error("test requires sh on PATH");
    process.env.SHELL = shell;
    try {
      expect(loginShell()).toBe(shell);
      expect(darwinPtyArgv()).toEqual(["script", "-q", "/dev/null", shell, "-l"]);
      expect(linuxPtyArgv()).toEqual(["script", "-q", "-c", `'${shell}' -l`, "/dev/null"]);
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

describe("PTY resize", () => {
  test("parses the platform tty names and rejects ps noise", () => {
    expect(parseTty("  ttys007\n")).toBe("ttys007");
    expect(parseTty("pts/3\n")).toBe("pts/3");
    expect(parseTty("?\n")).toBeNull();
    expect(parseTty("pts/3\npts/4")).toBeNull();
  });

  test("builds the outside stty command for macOS and Linux", () => {
    expect(ttyForPidArgv(42)).toEqual(["ps", "-o", "tty=", "-p", "42"]);
    expect(sttyResizeArgv("darwin", "/dev/ttys007", 120, 40)).toEqual([
      "stty",
      "-f",
      "/dev/ttys007",
      "rows",
      "40",
      "cols",
      "120",
    ]);
    expect(sttyResizeArgv("linux", "/dev/pts/3", 120, 40)).toEqual([
      "stty",
      "-F",
      "/dev/pts/3",
      "rows",
      "40",
      "cols",
      "120",
    ]);
  });

  test("discovers the shell tty and resizes from outside the shell", async () => {
    const seen: string[][] = [];
    const spawn: TerminalSpawnFn = (cmd) => {
      seen.push(cmd);
      if (cmd[1] === "-axo") {
        return { exitCode: 0, stdout: " 100 1 script\n 101 100 /bin/bash\n", stderr: "" };
      }
      if (cmd[0] === "ps") return { exitCode: 0, stdout: " pts/3\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let injected = false;
    const result = await resizePty({
      rootPid: 100,
      shell: "/bin/bash",
      platform: "linux",
      cols: 120,
      rows: 40,
      device: null,
      spawn,
      fallback: () => {
        injected = true;
      },
    });

    expect(result.usedPty).toBe(true);
    expect(result.device).toEqual({ pid: 101, path: "/dev/pts/3" });
    expect(injected).toBe(false);
    expect(seen).toEqual([
      ["ps", "-axo", "pid=,ppid=,comm="],
      ["ps", "-o", "tty=", "-p", "101"],
      ["stty", "-F", "/dev/pts/3", "rows", "40", "cols", "120"],
    ]);
  });

  test("falls back to the injected command when tty discovery fails", async () => {
    const seen: string[][] = [];
    const spawn: TerminalSpawnFn = (cmd) => {
      seen.push(cmd);
      return { exitCode: 1, stdout: "", stderr: "ps failed" };
    };
    let injected = "";
    const result = await resizePty({
      rootPid: 100,
      shell: "/bin/bash",
      platform: "linux",
      cols: 120,
      rows: 40,
      device: null,
      spawn,
      fallback: () => {
        injected = "stty rows 40 cols 120\r";
      },
    });

    expect(result.usedPty).toBe(false);
    expect(injected).toBe("stty rows 40 cols 120\r");
    expect(seen).toEqual([["ps", "-axo", "pid=,ppid=,comm="]]);
  });
});

describe("ReplayBuffer", () => {
  test("returns everything it was given while under the cap", () => {
    const buffer = new ReplayBuffer(64);
    buffer.push("hello ");
    buffer.push("world");
    expect(buffer.text()).toBe("hello world");
    expect(buffer.length).toBe(11);
  });

  test("ignores empty writes rather than growing a chunk list of nothing", () => {
    const buffer = new ReplayBuffer(64);
    buffer.push("");
    expect(buffer.text()).toBe("");
    expect(buffer.length).toBe(0);
  });

  test("drops WHOLE chunks from the front, never slicing mid-escape-sequence", () => {
    const buffer = new ReplayBuffer(10);
    buffer.push("aaaaa");
    buffer.push("bbbbb");
    buffer.push("ccccc"); // pushes past the cap; "aaaaa" leaves entire
    expect(buffer.text()).toBe("bbbbbccccc");
    expect(buffer.length).toBe(10);
  });

  test("a single chunk past the cap keeps its TAIL — the newest output", () => {
    const buffer = new ReplayBuffer(5);
    buffer.push("0123456789");
    expect(buffer.text()).toBe("56789");
    expect(buffer.length).toBe(5);
  });

  test("stays within the cap under sustained output", () => {
    const buffer = new ReplayBuffer(100);
    for (let i = 0; i < 500; i++) buffer.push(`line ${i}\n`);
    expect(buffer.length).toBeLessThanOrEqual(100);
    expect(buffer.text().endsWith("line 499\n")).toBe(true);
  });
});

describe("sessionKey", () => {
  test("names one shell per (task, tab), so tabs are separate processes", () => {
    expect(sessionKey("tabc", 0)).toBe("tabc:0");
    expect(sessionKey("tabc", 3)).toBe("tabc:3");
    expect(sessionKey("tabc", 0)).not.toBe(sessionKey("tdef", 0));
  });
});
