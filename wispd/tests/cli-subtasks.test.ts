// The CLI's subtask flags: refused against a daemon that cannot make
// subtasks (before anything is uploaded), contradictions refused before any
// request, and `wisp ls` nesting children under their parent.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTaskListItem } from "../../shared/api/task";
import { nestedTasks } from "../src/cli-subtasks";
import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import { listTasks } from "../src/store";

const token = "cli-subtasks-test-token";
const entry = join(import.meta.dir, "..", "src", "index.ts");
let server: Awaited<ReturnType<typeof serve>> | null = null;

function writeConfig(port: number): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    port, host: "127.0.0.1", token, webhooks: [], repos: [], stuckMinutes: 10, logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
  }));
}

/** A daemon with the feature off: what an older daemon looks like to this CLI. */
async function startDaemon(): Promise<void> {
  writeConfig(18710);
  server = await serve({ port: 0, modelProbeSpawn: () => { throw new Error("probe disabled in tests"); }, modelProbeTimeoutMs: 100 });
  writeConfig(server.port!);
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

// async spawn: the daemon under test answers from this process's event loop
async function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const clean = { ...process.env };
  delete clean.WISP_TASK_ID;
  delete clean.WISP_AGENT_TURN;
  const proc = Bun.spawn({ cmd: ["bun", entry, ...args], env: { ...clean, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("wisp new and wisp archive with subtask flags", () => {
  test("a daemon that cannot make subtasks gets a refusal, never a root task, and nothing is uploaded first", async () => {
    await startDaemon();
    const image = join(mkdtempSync(join(tmpdir(), "wisp-cli-subtasks-")), "shot.png");
    writeFileSync(image, "not really a png");
    const before = listTasks(true).length;
    const created = await run(["new", "--parent", "tabcde", "look into it", "--harness", "claude", "--attach", image]);
    expect(created.exitCode).toBe(1);
    expect(created.stderr).toContain("this daemon does not make subtasks");
    expect(created.stderr).not.toContain("upload");
    const archived = await run(["archive", "tabcde", "--subtasks", "archive"]);
    expect(archived.exitCode).toBe(1);
    expect(archived.stderr).toContain("this daemon does not make subtasks");
    expect(listTasks(true).length).toBe(before);
  });

  test("contradictions and bad values are refused before any request", async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [["new", "--subtask", "x", "--harness", "claude"], {}, "--subtask works inside a Wisp task"],
      [["new", "--subtask", "--parent", "tabcde", "x", "--harness", "claude"], { WISP_TASK_ID: "tself" }, "not both"],
      [["new", "--parent", "tabcde", "--kind", "sideways", "x", "--harness", "claude"], {}, "--kind must be one of review, explore, continue"],
      [["new", "--report", "x", "--harness", "claude"], {}, "--report and --kind need --subtask or --parent"],
      [["archive", "tabcde", "--subtasks", "everything"], {}, "--subtasks takes archive or force"],
      [["archive", "tabcde", "--subtasks"], {}, "--subtasks takes archive or force"],
    ];
    for (const [args, env, message] of cases) {
      const result = await run(args, env);
      expect({ args, exitCode: result.exitCode, said: result.stderr.includes(message) }).toEqual({ args, exitCode: 1, said: true });
    }
  });
});

describe("wisp ls", () => {
  test("children are listed under their parent, a child whose parent is not listed stands alone", () => {
    const task = (id: string, parent: string | null = null) => ({ id, parent_task_id: parent }) as ApiTaskListItem;
    const order = nestedTasks([task("tchild", "troot"), task("troot"), task("tother"), task("tgrand", "tchild"), task("tlone", "tgone")])
      .map(({ task: t, depth }) => `${depth}:${t.id}`);
    expect(order).toEqual(["0:troot", "1:tchild", "2:tgrand", "0:tother", "0:tlone"]);
  });
});
