import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH } from "../src/config";
import { parseTerminalSize, serve } from "../src/daemon";
import { subscribe } from "../src/events";
import {
  closeShell,
  createShell,
  DEFAULT_PTY_SIZE,
  DISPLACED_MESSAGE,
  killAll,
  killForTask,
  listShells,
  openSession,
  loginShellArgv,
  renameShell,
  resolveLoginShell,
  restartShell,
  sessionKey,
  ShellConflictError,
  WEB_TERMINAL_TERM,
  webTerminalEnv,
  type ShellInfo,
  type TerminalClient,
} from "../src/terminal";
import { MAX_SHELL_TITLE_LENGTH, noteShell } from "../src/terminal-tabs";
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

/**
 * Teardown gets an explicit timeout, because it can legitimately outlast the
 * 5s one `bun:test` gives a hook by default.
 *
 * `killAll()` walks every live session through `Session.kill()`, and that is a
 * SIGHUP plus up to `KILL_GRACE_MS` (5s) for the shell to go, then a SIGKILL
 * plus another 5s — 10s of honest waiting per session in the worst case. On a
 * developer's machine the shell exits on the hangup in milliseconds and the
 * whole file runs in ~2s, so the default was never felt; on a loaded CI runner
 * one slow hangup crossed 5s and the hook was killed mid-teardown, which
 * failed the test that had just PASSED and then the next one, whose server had
 * been left standing. The tests themselves already ask for 20s.
 */
afterEach(async () => {
  await killAll();
  if (server) await server.stop(true);
  server = null;
}, 30_000);


/**
 * One task with a real worktree, plus the config the daemon needs to serve it.
 * Every terminal test needs the same thing, and repeating it inline made the
 * suite mostly setup — the interesting part of each test is what it does to
 * the shell afterwards.
 */
function terminalFixture(label: string, terminalShell?: string): { task: ReturnType<typeof createTask>; worktree: string } {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 18710,
      host: "127.0.0.1",
      token,
      webhooks: [],
      stuckMinutes: 10,
      ...(terminalShell ? { terminalShell } : {}),
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );

  const root = mkdtempSync(join(tmpdir(), `wisp-terminal-${label}-test-`));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "terminal-test@wisp"]);
  git(repo, ["config", "user.name", "terminal-test"]);
  writeFileSync(join(repo, "README"), `terminal ${label} test\n`);
  git(repo, ["add", "README"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const taskId = newTaskId();
  const branch = `wisp/${taskId}-terminal-${label}`;
  git(repo, ["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
  const task = createTask({
    id: taskId,
    title: `terminal ${label} test`,
    repo_path: repo,
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  setTaskFields(task.id, { worktree_path: worktree, branch, base_commit: git(repo, ["rev-parse", "HEAD"]) });
  return { task, worktree };
}

describe("embedded web terminal", () => {
  test("runs in the worktree and archive kills the attached shell", async () => {
    const { task, worktree } = terminalFixture("attach");

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
      const { task, worktree } = terminalFixture("respawn");

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
      const { task } = terminalFixture("replay");

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
      const { task } = terminalFixture("displace");

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

  test(
    "the shell is created at the size the upgrade asked for",
    { timeout: 20_000 },
    async () => {
      // The whole fix depends on this wiring: the pane measures itself, the
      // size rides on the upgrade, and openSession creates the pty with it.
      // Unit tests cover each half; this is the only place the daemon path
      // from query string to a real shell's window size is exercised.
      const { task } = terminalFixture("size");

      server = await serve({ port: 0 });
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal?shell=0&cols=58&rows=9`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      let seen = "";
      let resolveSize!: () => void;
      let rejectSize!: (error: Error) => void;
      const reported = new Promise<void>((resolve, reject) => {
        resolveSize = resolve;
        rejectSize = reject;
      });
      ws.onerror = () => rejectSize(new Error("terminal websocket error"));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "hello") {
          expect(message.pty).toBe(true);
          ws.send(JSON.stringify({ type: "in", data: "stty size\n" }));
        }
        if (message.type === "out") {
          seen += String(message.data);
          // "9 58" is rows then cols: the shell was born knowing the pane
          if (/\b9 58\b/.test(seen)) resolveSize();
        }
      };
      await waitFor(reported, 15_000);
      ws.close();
    },
  );

  test("the daemon launches the configured terminal shell", async () => {
    const shellRoot = mkdtempSync(join(tmpdir(), "wisp-terminal-configured-shell-test-"));
    const shell = join(shellRoot, "test-shell");
    writeFileSync(shell, '#!/bin/sh\nprintf "configured-shell-started\\n"\nexec /bin/sh "$@"\n');
    chmodSync(shell, 0o755);
    const { task } = terminalFixture("configured-shell", shell);

    server = await serve({ port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal`, {
      headers: { authorization: `Bearer ${token}` },
    });
    let seen = "";
    const started = new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error("configured terminal websocket error"));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "hello") seen += String(message.replay ?? "");
        if (message.type === "out") seen += String(message.data ?? "");
        if (seen.includes("configured-shell-started")) resolve();
      };
    });

    await waitFor(started, 10_000);
    ws.close();
  });

  test(
    "killing a shell does not wait out the SIGKILL grace period",
    { timeout: 20_000 },
    async () => {
      // An interactive shell IGNORES SIGTERM. While the shell ran under
      // script(1) that did not matter, because script does not; now the shell
      // is the child, so terminating it with SIGTERM would make every archive
      // and every daemon shutdown sit through the full grace period first.
      const { task } = terminalFixture("kill");

      server = await serve({ port: 0 });
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${task.id}/terminal?shell=0&cols=80&rows=24`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // Kill it from an interactive PROMPT, not from a shell still starting
      // up: a shell that has finished initialising is the one that has its
      // signal handling in place, and it is the state a real pane is in.
      let seen = "";
      let started = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      ws.onerror = () => rejectReady(new Error("terminal websocket error"));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type === "hello") ws.send(JSON.stringify({ type: "in", data: "echo shell-ready\n" }));
        if (message.type === "out" && /shell-ready/.test(seen + String(message.data)) && !started) {
          started = true;
          // a foreground job, so the kill has to reach the whole process group
          ws.send(JSON.stringify({ type: "in", data: "sleep 30\n" }));
        }
        if (message.type === "out") {
          seen += String(message.data);
          if (/shell-ready/.test(seen)) resolveReady();
        }
      };
      await waitFor(ready, 10_000);
      await Bun.sleep(500); // let `sleep 30` become the foreground job

      const killedAt = Date.now();
      await killForTask(task.id);
      // The grace period before SIGKILL is 5s; a shell that honours the signal
      // is gone in well under a second.
      expect(Date.now() - killedAt).toBeLessThan(3_000);
      ws.close();
    },
  );

  test("rejects a shell id outside the per-task range instead of upgrading", async () => {
      const { task } = terminalFixture("shellid");

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

  test("an explicit terminalShell wins over account and inherited values", () => {
    expect(resolveLoginShell("/configured/zsh", "/account/bash", "/inherited/fish", "linux", () => true)).toBe(
      "/configured/zsh",
    );
    expect(loginShellArgv("/configured/zsh")).toEqual(["/configured/zsh", "-l"]);
  });

  test("the account shell wins over inherited service state", () => {
    expect(resolveLoginShell(undefined, "/account/zsh", "/inherited/bash", "linux", () => true)).toBe(
      "/account/zsh",
    );
  });

  test("falls back through $SHELL to the platform default", () => {
    expect(resolveLoginShell(undefined, null, "/inherited/fish", "linux", () => true)).toBe("/inherited/fish");
    expect(resolveLoginShell(undefined, "/missing/account", "/missing/env", "darwin", () => false)).toBe(
      "/bin/zsh",
    );
    expect(resolveLoginShell(undefined, undefined, undefined, "linux", () => false)).toBe("/bin/bash");
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

/**
 * What happens to a session that has been ASKED to die.
 *
 * A shell that outlives SIGKILL (a loaded host, a process blocked in the
 * kernel) used to keep `finished === false` and stay in the reusable map,
 * because the bookkeeping only ran when `kill()` returned normally. The next
 * client was then handed that undead session and its first resize threw — seen
 * in CI as a terminal that errored the instant it opened. It also has to stay
 * TRACKED, or archive's fail-closed gate would report success while a process
 * was still sitting in the worktree.
 */
describe("retiring a killed shell", () => {
  test("a shell being killed is never handed to an arriving client", async () => {
    const { task, worktree } = terminalFixture("retire");
    const first = openSession(task.id, 0, worktree);

    // Not awaited: the kill is in flight, which is exactly the window where
    // the old code would hand this same session to the next client. Nor is
    // it replaced yet: a second process under the same key would be one the
    // retiring kill no longer tracks.
    const killing = killForTask(task.id);
    expect(first.isLive()).toBe(false);
    expect(() => openSession(task.id, 0, worktree)).toThrow(ShellConflictError);

    await killing;
    expect(openSession(task.id, 0, worktree)).not.toBe(first);
    await killAll();
  }, 30_000);

  test("a shell that ignores its hangup keeps its id, and archive waits for it", async () => {
    const { task, worktree } = terminalFixture("stubborn");
    const tab = createShell(task.id);
    const session = openSession(task.id, tab.id, worktree);
    const client = recordingClient();
    session.attach(client);
    await session.write(client, "trap '' HUP; echo trap-$((40+2))\n");
    await until(() => client.output().includes("trap-42"));

    // SIGHUP is ignored, so this sits out the grace period before SIGKILL
    const closing = closeShell(task.id, tab.id, true);
    expect(session.isClosing()).toBe(true);
    expect(createShell(task.id).id).not.toBe(tab.id);
    expect(() => openSession(task.id, tab.id, worktree)).toThrow(ShellConflictError);

    let archived = false;
    const archiving = killForTask(task.id).then(() => {
      archived = true;
    });
    await Bun.sleep(200);
    expect(archived).toBe(false);
    expect(session.hasExited()).toBe(false);

    await closing;
    await archiving;
    expect(session.hasExited()).toBe(true);
  }, 30_000);

  test("a killed shell is replaced, not reused, by the next attach", async () => {
    const { task, worktree } = terminalFixture("replace");
    const first = openSession(task.id, 0, worktree);
    await killForTask(task.id);

    const second = openSession(task.id, 0, worktree);
    expect(second).not.toBe(first);
    expect(second.isLive()).toBe(true);
    await killAll();
  }, 30_000);
});

/** A client that records what the shell sends, for driving a session without a socket. */
function recordingClient(): TerminalClient & { output: () => string; exits: number[] } {
  let output = "";
  const exits: number[] = [];
  return {
    isOpen: () => true,
    sendOutput: (data) => {
      output += data;
    },
    sendError: () => {},
    sendExit: (code) => {
      exits.push(code);
    },
    output: () => output,
    exits,
  };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

describe("shell tabs", () => {
  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(`http://127.0.0.1:${server!.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
  }

  test("a new tab never takes a closed tab's number, though it may reuse its socket id", async () => {
    const { task } = terminalFixture("numbers");
    server = await serve({ port: 0 });
    const base = `/api/tasks/${task.id}/terminals`;

    const first = (await (await api(base, { method: "POST" })).json()) as ShellInfo;
    const second = (await (await api(base, { method: "POST" })).json()) as ShellInfo;
    expect([first.id, first.number, second.id, second.number]).toEqual([0, 1, 1, 2]);
    expect(second.shell.length).toBeGreaterThan(0);

    expect((await api(`${base}/0`, { method: "DELETE" })).status).toBe(200);
    const third = (await (await api(base, { method: "POST" })).json()) as ShellInfo;
    expect(third.id).toBe(0);
    expect(third.number).toBe(3);

    const listed = (await (await api(base)).json()) as ShellInfo[];
    expect(listed.map((shell) => shell.number)).toEqual([2, 3]);
    expect((await api(`${base}/7`, { method: "DELETE" })).status).toBe(404);
  });

  test("two windows asking for a tab-less task's first tab get the same one", async () => {
    const { task } = terminalFixture("if-empty");
    server = await serve({ port: 0 });
    const first = `/api/tasks/${task.id}/terminals?ifEmpty=1`;
    const answers = await Promise.all([api(first, { method: "POST" }), api(first, { method: "POST" })]);
    const tabs = (await Promise.all(answers.map((answer) => answer.json()))) as ShellInfo[];
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(tabs[0]!.id).toBe(tabs[1]!.id);
    expect(listShells(task.id)).toHaveLength(1);
  });

  test("closing a tab hangs up its shell, and asks first while a program runs", async () => {
    const { task, worktree } = terminalFixture("close");
    server = await serve({ port: 0 });
    const base = `/api/tasks/${task.id}/terminals`;
    const tab = (await (await api(base, { method: "POST" })).json()) as ShellInfo;

    const session = openSession(task.id, tab.id, worktree);
    const client = recordingClient();
    session.attach(client);
    await session.write(client, "echo tab-ready\n");
    await until(() => client.output().includes("tab-ready"));
    await session.write(client, "sleep 30\n");
    await until(() => session.foregroundProgram() === "sleep");

    const refused = await api(`${base}/${tab.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { program: string }).program).toBe("sleep");
    expect(session.isLive()).toBe(true);

    expect((await api(`${base}/${tab.id}?force=1`, { method: "DELETE" })).status).toBe(200);
    expect(session.hasExited()).toBe(true);
    expect(listShells(task.id)).toEqual([]);
  }, 30_000);

  test("a shell that exits by itself closes its tab, unless it was the last one", async () => {
    const { task, worktree } = terminalFixture("exit");
    const first = createShell(task.id);
    const second = createShell(task.id);
    const shells = [first, second].map((tab) => {
      const session = openSession(task.id, tab.id, worktree);
      const client = recordingClient();
      session.attach(client);
      return { session, client };
    });

    await shells[0]!.session.write(shells[0]!.client, "exit\n");
    await until(() => shells[0]!.session.hasExited() && listShells(task.id).length === 1);
    expect(listShells(task.id)[0]!.id).toBe(second.id);

    await shells[1]!.session.write(shells[1]!.client, "exit 3\n");
    await until(() => listShells(task.id)[0]?.exitCode === 3);
    expect(listShells(task.id)).toHaveLength(1);

    // attaching again starts a fresh shell in that same tab
    openSession(task.id, second.id, worktree);
    expect(listShells(task.id)[0]!.exitCode).toBeNull();
  }, 30_000);

  test("rename keeps the tab; an empty name hands back the automatic one", async () => {
    const { task } = terminalFixture("rename");
    server = await serve({ port: 0 });
    const base = `/api/tasks/${task.id}/terminals`;
    const tab = (await (await api(base, { method: "POST" })).json()) as ShellInfo;

    const named = await api(`${base}/${tab.id}`, { method: "PATCH", body: JSON.stringify({ name: "  dev server " }) });
    expect(((await named.json()) as ShellInfo).name).toBe("dev server");
    const reset = await api(`${base}/${tab.id}`, { method: "PATCH", body: JSON.stringify({ name: "" }) });
    expect(((await reset.json()) as ShellInfo).name).toBeNull();
    expect((await api(`${base}/${tab.id}`, { method: "PATCH", body: JSON.stringify({ name: 7 }) })).status).toBe(400);
    expect(
      (await api(`${base}/${tab.id}`, { method: "PATCH", body: JSON.stringify({ name: "x".repeat(65) }) })).status,
    ).toBe(400);
  });

  test("restart replaces the shell and keeps the tab's number and name", async () => {
    const { task, worktree } = terminalFixture("restart");
    const tab = createShell(task.id);
    renameShell(task.id, tab.id, "api");
    const session = openSession(task.id, tab.id, worktree);

    const outcome = await restartShell(task.id, tab.id, false);
    expect(outcome.kind).toBe("done");
    expect(session.hasExited()).toBe(true);
    const fresh = openSession(task.id, tab.id, worktree);
    expect(fresh).not.toBe(session);
    expect(listShells(task.id)).toMatchObject([{ id: tab.id, number: tab.number, name: "api" }]);
  }, 30_000);

  test("every tab change is announced, and a shell opened by attaching gets a tab", async () => {
    const { task, worktree } = terminalFixture("announce");
    const seen: string[] = [];
    const unsubscribe = subscribe((event) => {
      if (event.type === "terminals") seen.push(event.taskId);
    });
    try {
      // an older client opens shells by attaching and never asks for a tab
      openSession(task.id, 5, worktree);
      expect(listShells(task.id).map((shell) => shell.id)).toEqual([5]);
      await until(() => seen.length > 0);
      expect(seen).toContain(task.id);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  test("a clear drops what the shell printed from the screen a reattach is sent", async () => {
    const { task, worktree } = terminalFixture("clear");
    const session = openSession(task.id, 0, worktree);
    const client = recordingClient();
    session.attach(client);
    await session.write(client, "echo clear-me-$((1+1))\n");
    await until(() => client.output().includes("clear-me-2"));
    expect(await session.scrollback()).toContain("clear-me-2");

    await session.clear(client);
    expect(await session.scrollback()).not.toContain("clear-me-2");
  }, 30_000);

  test("a title a program sets is kept to a bounded length", () => {
    const { task } = terminalFixture("title");
    const tab = createShell(task.id);
    noteShell(sessionKey(task.id, tab.id), { title: "t".repeat(10_000) });
    expect(listShells(task.id)[0]!.title).toBe("t".repeat(MAX_SHELL_TITLE_LENGTH));
  });

  test("archiving a task forgets its tabs", async () => {
    const { task } = terminalFixture("archive-tabs");
    createShell(task.id);
    createShell(task.id);
    await killForTask(task.id);
    expect(listShells(task.id)).toEqual([]);
    expect(createShell(task.id).number).toBe(1);
  });
});

describe("sessionKey", () => {
  test("names one shell per (task, tab), so tabs are separate processes", () => {
    expect(sessionKey("tabc", 0)).toBe("tabc:0");
    expect(sessionKey("tabc", 3)).toBe("tabc:3");
    expect(sessionKey("tabc", 0)).not.toBe(sessionKey("tdef", 0));
  });
});
