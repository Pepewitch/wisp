import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { COMMANDS } from "../src/cli";
import { briefHelp, briefUsage } from "../src/cli-brief-help";
import { COMMAND_ALIASES, commandHelp, HELP, offlineAnswer, resolveCommand, workflowUsage } from "../src/cli-help";
import { workflowCommand } from "../src/cli-workflow";

const WISPD = resolve(import.meta.dir, "..");

/** Every name the dispatcher answers to, taken from the dispatcher itself. */
const NAMES = [...Object.keys(COMMANDS), ...Object.keys(COMMAND_ALIASES)];

/** Every temporary directory this file makes, removed when it ends. */
const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], home: string) {
  // this suite may run inside a Wisp turn, or under wisp-dev: none of that may leak in
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

/** Every file under `dir` with its size and modification time: any write shows up here. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const stat = statSync(path);
    files[path] = `${stat.size}:${stat.mtimeMs}`;
  }
  return files;
}

/** What `<name> …--help…` must print: its usage, and only that. */
function expectedHelp(name: string, args: string[]): string {
  const command = resolveCommand(name)!;
  if (command !== "brief") return commandHelp(command);
  // brief keeps its agent-facing help (cli-brief-help.ts)
  return args[1] === "--help" || args[1] === "-h" ? briefHelp() : briefUsage();
}

describe("--help runs nothing", () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  const requests: string[] = [];
  let before: Record<string, string>;

  beforeAll(async () => {
    home = join(tempDir("wisp-cli-help-"), "home");
    // init refuses a port something already listens on, so reserve one, init, then serve it
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const init = await run(["init", "--port", String(port)], home);
    expect(init.err).toBe("");
    expect(init.exit).toBe(0);
    // the daemon every command would talk to: it records, and answers nothing useful
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: "this test's daemon answers no command" }, { status: 418 });
      },
    });
    before = snapshot(home);
  });

  afterAll(() => server.stop(true));

  test("the dispatcher and the help list the same commands", () => {
    expect(NAMES.length).toBeGreaterThan(25);
    for (const name of Object.keys(COMMANDS)) expect(HELP).toContain(`  wisp ${name}`);
  });

  test.each(NAMES)("%s --help prints its usage and exits 0 without a home, a daemon, or a write", async (name) => {
    // before the home exists: nothing may create it
    const absent = join(tempDir("wisp-cli-help-absent-"), "home");
    const bare = await run([name, "--help"], absent);
    expect(bare).toEqual({ exit: 0, out: `${expectedHelp(name, [name, "--help"]).trimEnd()}\n`, err: "" });
    expect(existsSync(absent)).toBe(false);

    // with a home and a live daemon, after arguments that would otherwise act
    for (const args of [[name, "tabcde", "on", "-h"], [name, "--force", "--help", "--json"]]) {
      const r = await run(args, home);
      expect(r).toEqual({ exit: 0, out: `${expectedHelp(name, args).trimEnd()}\n`, err: "" });
    }
    expect(requests).toEqual([]);
    expect(snapshot(home)).toEqual(before);
  });

  test("help <command> is the same answer as <command> --help; help <unknown> refuses", async () => {
    for (const name of NAMES) {
      const command = resolveCommand(name)!;
      if (command === "brief") continue;
      expect(offlineAnswer(["help", name])).toEqual({ text: commandHelp(command), exit: 0, stream: "out" });
    }
    expect(offlineAnswer(["help"])).toEqual({ text: HELP, exit: 0, stream: "out" });
    expect(offlineAnswer(["help", "help"])).toEqual({ text: HELP, exit: 0, stream: "out" });
    expect(offlineAnswer([])).toEqual({ text: HELP, exit: 0, stream: "out" });
    expect(offlineAnswer(["-h"])).toEqual({ text: HELP, exit: 0, stream: "out" });
    const unknown = await run(["help", "nope"], home);
    expect(unknown.exit).toBe(1);
    expect(unknown.err).toStartWith("unknown command: nope\n");
    expect(unknown.out).toBe("");
  });

  test("an unknown command exits 1 with the command list, and its name cannot drive the terminal", async () => {
    const r = await run(["no\u001b]52;c;ZXZpbA==\u0007pe"], home);
    expect(r.exit).toBe(1);
    expect(r.err).toStartWith("unknown command: nope\n");
    expect(r.err).toContain("wisp help [command]");
    expect(requests).toEqual([]);
  });

  test("an unknown subcommand exits nonzero with a usage hint and asks the daemon nothing", async () => {
    for (const args of [["workflow", "strat", "tabcde", "heartbeat"], ["project", "nope"], ["pr", "tabcde", "nope"], ["brief", "nope"]]) {
      const r = await run(args, home);
      expect(r.exit, args.join(" ")).not.toBe(0);
      expect(r.err, args.join(" ")).toContain("usage:");
      expect(r.out).toBe("");
    }
    expect(requests).toEqual([]);
  });
});

describe("wisp workflow without a known verb", () => {
  const api = async () => {
    throw new Error("no request expected");
  };

  test("bare prints its usage", async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      await workflowCommand([], {}, api);
    } finally {
      console.log = log;
    }
    expect(printed).toEqual([workflowUsage()]);
  });

  test("a mistyped verb is a refusal that names it", async () => {
    await expect(workflowCommand(["strat", "tabcde", "heartbeat"], {}, api)).rejects.toThrow(/^unknown workflow command: strat\nusage: /);
  });
});
