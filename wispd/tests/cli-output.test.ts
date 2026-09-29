import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { print, printRaw } from "../src/cli-print";
import { terminalText } from "../src/cli-stream";
import { controlFree } from "../src/control-free";

/**
 * Agent and repository text must not drive the reader's terminal. Everything
 * a task shows is text an agent (or whatever it read) chose: set the
 * clipboard (OSC 52), clear the screen and recolour (CSI), or the C1 forms.
 */
const OSC52 = "\u001b]52;c;ZXZpbA==\u0007";
const CSI = "\u001b[2J\u001b[31m";
const C1 = "\u009b31m";
const hostile = (visible: string) => `${visible}${OSC52} and${CSI} more${C1}`;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const WISPD = resolve(import.meta.dir, "..");

async function run(args: string[], home: string) {
  const { NODE_ENV: _node, WISP_BRIEF_RUN: _run, WISP_TASK_ID: _task, WISP_COMMAND_NAME: _name, ...inherited } = process.env;
  const child = Bun.spawn({
    cmd: [process.execPath, "src/index.ts", ...args],
    cwd: WISPD,
    env: { ...inherited, WISP_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, out, err };
}

/** One claude stream-json line whose assistant text is the agent's. */
const claudeLine = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

const task = {
  id: "tabcde",
  state: "done",
  state_detail: hostile("detail"),
  harness: "claude",
  model: null,
  session_id: "s1",
  worktree_path: "/example/worktree",
  branch: hostile("wisp/branch"),
  worktreeReason: null,
  archived: false,
  turns: [{
    n: 1,
    status: "done",
    model: "m",
    requested_model: null,
    exit_code: 0,
    prompt: hostile("please"),
    result: `${hostile("answer")}\n\tsecond line`,
    attachments: [{ name: hostile("shot.png"), size: 10 }],
    usage: null,
  }],
  messages: [],
  diffstat: hostile(" file.ts | 2 +-"),
};

const search = {
  query: "answer",
  truncated: false,
  tasks: [{
    id: "tabcde",
    state: "done",
    archived: false,
    repo_path: "/example/repo",
    title: hostile("title"),
    matches: 1,
    snippets: [{ kind: "result", turn: 1, text: hostile("snippet") }],
  }],
};

function sse(frames: [string, unknown][]): Response {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("agent text printed by the CLI", () => {
  let scratch: string;
  let home: string;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "wisp-cli-output-"));
    home = join(scratch, "home");
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    expect((await run(["init", "--port", String(port)], home)).exit).toBe(0);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/api/tasks/tabcde") return Response.json(task);
        if (pathname === "/api/tasks/tabcde/log") {
          return Response.json({ harness: "claude", out: `${claudeLine(hostile("said"))}\n`, err: hostile("stderr"), status: "done", size: 1, turn: 1 });
        }
        if (pathname === "/api/tasks/tabcde/log/stream") {
          return sse([["backlog", { text: hostile("live") }], ["turn-end", { turn: 1, status: "done" }]]);
        }
        if (pathname === "/api/search") return Response.json(search);
        return Response.json({ error: hostile("refused") }, { status: 409 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  });

  test.each([
    [["show", "tabcde"], ["answer and more", "detail and more", "wisp/branch and more", "shot.png and more", "file.ts | 2 +-"]],
    [["result", "tabcde"], ["please and more", "answer and more", "\n\tsecond line"]],
    [["log", "tabcde"], ["said and more"]],
    [["log", "tabcde", "-f"], ["live and more", "— turn 1 done —"]],
    [["search", "answer"], ["title and more", "snippet and more"]],
  ])("%p keeps the words, newlines and tabs, and drops the control sequences", async (args, visible) => {
    const r = await run(args, home);
    expect(r.err).not.toMatch(CONTROL);
    expect(r.exit, r.err).toBe(0);
    expect(r.out).not.toMatch(CONTROL);
    for (const text of visible) expect(r.out).toContain(text);
  });

  test("harness stderr and a daemon refusal are cleaned too", async () => {
    const log = await run(["log", "tabcde"], home);
    expect(log.err).toBe("stderr and more31m\n");
    const refused = await run(["push", "tabcde"], home);
    expect(refused.exit).toBe(1);
    expect(refused.err).toBe("error: refused and more31m\n");
  });

  test("--json stays lossless, with C1 controls escaped", async () => {
    const r = await run(["search", "answer", "--json"], home);
    expect(r.exit).toBe(0);
    expect(r.out).not.toMatch(CONTROL);
    expect(JSON.parse(r.out)).toEqual(search);
  });

  test("--raw into a pipe keeps the retained bytes exactly", async () => {
    const r = await run(["log", "tabcde", "--raw"], home);
    expect(r.exit).toBe(0);
    expect(r.out).toBe(`${claudeLine(hostile("said"))}\n\n`);
    expect(r.err).toBe(`${hostile("stderr")}\n`);
  });
});

describe("controlFree", () => {
  test("a carriage return is a line break, and CRLF is one", () => {
    expect(controlFree("Counting: 50%\rCounting: 100%")).toBe("Counting: 50%\nCounting: 100%");
    expect(controlFree("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  test("CSI with any parameter byte is removed whole", () => {
    // device attributes (`>`), colon-separated SGR (`:`), private modes (`?`)
    expect(controlFree("a\u001b[>0cb\u001b[4:3mc\u001b[?25ld\u001b[=1;2<pe")).toBe("abcde");
  });
});

describe("the --diagnostic stream on a terminal", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("a CRLF or a character split across chunks survives, and the end is flushed", () => {
    const decode = terminalText();
    const snowman = bytes("☃");
    const parts = [decode(bytes("a\r")), decode(bytes("\nb")), decode(snowman.slice(0, 1)), decode(snowman.slice(1)), decode(bytes("\r"))];
    expect(parts.join("") + decode(undefined)).toBe("a\nb☃\n");
    expect(parts).toEqual(["a", "\nb", "", "☃", ""]);
  });

  test("control sequences are removed", () => {
    const decode = terminalText();
    expect(decode(bytes(`{"text":"x${OSC52}"}\n`)) + decode(undefined)).toBe(`{"text":"x"}\n`);
  });
});

describe("the CLI's printers", () => {
  test("print strips control sequences and keeps newlines and tabs", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      print(`a${OSC52}\n\tb${CSI}${C1}`);
      expect(log).toHaveBeenCalledWith("a\n\tb31m");
    } finally {
      log.mockRestore();
    }
  });

  test("--raw output is cleaned only when it reaches a terminal", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const tty = process.stdout.isTTY;
    try {
      process.stdout.isTTY = false;
      printRaw(`a${OSC52}`);
      process.stdout.isTTY = true;
      printRaw(`a${OSC52}`);
      expect(log.mock.calls).toEqual([[`a${OSC52}`], ["a"]]);
    } finally {
      process.stdout.isTTY = tty;
      log.mockRestore();
    }
  });
});
