import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_PATH, type WispConfig } from "../src/config";
import { searchLines, searchCommand } from "../src/cli-search";
import { serve } from "../src/daemon";
import { createTask, createTurn, finishTurn, freeSlot, newTaskId, setTaskFields } from "../src/store";
import type { SearchResponse, SearchTaskHit } from "../src/types";

/**
 * `wisp search`. The printed shape is unit-tested (pure), and the verb itself
 * is driven end-to-end through the real CLI entry against a real daemon —
 * scope, caps and refusals belong to the endpoint, so the command must be
 * proven to be nothing but a request and a printer.
 */

function hit(over: Partial<SearchTaskHit> & Pick<SearchTaskHit, "id">): SearchTaskHit {
  return {
    title: `task ${over.id}`,
    repo_path: "/Users/dev/work/wisp",
    updated_at: "2026-09-01T00:00:00Z",
    state: "done",
    archived: false,
    matches: 1,
    snippets: [{ kind: "prompt", turn: 2, text: "…please vacuum the reducer", offset: 8, length: 6 }],
    ...over,
  };
}

const answer = (tasks: SearchTaskHit[], truncated = false): SearchResponse => ({
  query: "vacuum",
  tasks,
  truncated,
});

describe("the printed answer", () => {
  test("one line per task, one indented line per snippet, and where it matched", () => {
    const lines = searchLines(answer([hit({ id: "taaaaa", title: "Vacuum the SSE bridge" })]), { all: false });

    expect(lines[0]).toContain("taaaaa");
    expect(lines[0]).toContain("✓ done");
    expect(lines[0]).toContain("wisp");
    expect(lines[0]).toContain("Vacuum the SSE bridge");
    expect(lines[1]).toBe("        prompt 2  …please vacuum the reducer");
  });

  test("marks a match count only when there is more than one", () => {
    expect(searchLines(answer([hit({ id: "taaaaa", matches: 1 })]), { all: false })[0]).not.toContain("matches");
    expect(searchLines(answer([hit({ id: "taaaaa", matches: 4 })]), { all: false })[0]).toContain("4 matches");
  });

  test("hides archived tasks by default and says how many it is holding back", () => {
    const lines = searchLines(
      answer([hit({ id: "taaaaa" }), hit({ id: "tzzzzz", archived: true })]),
      { all: false },
    );

    expect(lines.join("\n")).not.toContain("tzzzzz");
    expect(lines.at(-1)).toBe("1 archived task hidden — add -a to include it");
  });

  test("gives them their own heading under -a, because a gone worktree is not a live one", () => {
    const lines = searchLines(
      answer([hit({ id: "taaaaa" }), hit({ id: "tzzzzz", archived: true })]),
      { all: true },
    );

    expect(lines).toContain("archived");
    expect(lines.indexOf("archived")).toBeLessThan(lines.findIndex((line) => line.includes("tzzzzz")));
  });

  test("a miss says so, and points at -a when the misses are archived", () => {
    expect(searchLines(answer([]), { all: false })).toEqual(["no match for 'vacuum'"]);
    expect(searchLines(answer([hit({ id: "tzzzzz", archived: true })]), { all: false })).toEqual([
      "no match for 'vacuum'",
      "1 archived task matches — add -a to include it",
    ]);
  });

  test("says the prose index is still catching up — beside hits and instead of a miss", () => {
    const catching = { ...answer([hit({ id: "taaaaa" })]), indexing: { remainingTurns: 12 } };
    expect(searchLines(catching, { all: false }).at(-1)).toBe(
      "still indexing what the agent said in 12 older turns",
    );

    const miss = { ...answer([]), indexing: { remainingTurns: 1 } };
    expect(searchLines(miss, { all: false })).toEqual([
      "no match for 'vacuum'",
      "still indexing what the agent said in 1 older turn — try again shortly",
    ]);
  });

  test("confesses a capped answer", () => {
    expect(searchLines(answer([hit({ id: "taaaaa" })], true), { all: false }).at(-1)).toBe(
      "showing the most recent matches",
    );
  });
});

describe("the command", () => {
  test("joins every word into one needle, so a phrase needs no quoting", async () => {
    const asked: string[] = [];
    await searchCommand(["steer", "box"], {}, async (path) => {
      asked.push(path);
      return answer([]);
    });
    expect(asked).toEqual(["/api/search?q=steer%20box"]);
  });

  test("refuses an empty needle with a usage line rather than asking for everything", async () => {
    await expect(searchCommand([], {}, async () => answer([]))).rejects.toThrow(/usage: .* search <text>/);
  });

  test("--json prints the daemon's answer verbatim, for scripting", async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      await searchCommand(["vacuum"], { json: true }, async () => answer([hit({ id: "taaaaa" })]));
    } finally {
      console.log = log;
    }
    expect(JSON.parse(printed.join("\n")).tasks[0].id).toBe("taaaaa");
  });
});

const token = "cli-search-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;
const entry = join(import.meta.dir, "..", "src", "index.ts");

function writeConfig(port: number): void {
  const config: WispConfig = {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port,
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
  writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

// async spawn, never spawnSync: the daemon under test lives in THIS process
async function run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn({ cmd: ["bun", entry, ...args], env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("wisp search, end to end", () => {
  test("finds a live task's prompt and hides an archived match until -a", async () => {
    writeConfig(18710);
    server = await serve({ port: 0, proseBackfill: false });
    writeConfig(server.port);

    const live = newTaskId();
    createTask({ id: live, title: "Live cliword task", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
    const turn = createTurn(live, 1, "please cliword the reducer", null, "/tmp/l.jsonl");
    finishTurn(turn, "done", 0, "cliworded 4 files");

    const old = newTaskId();
    createTask({ id: old, title: "Archived cliword task", repo_path: "/tmp/repo", harness: "fake", model: null, slot: freeSlot() });
    setTaskFields(old, { archived: 1 });

    const plain = await run(["search", "cliword"]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain(live);
    expect(plain.stdout).not.toContain(old);
    expect(plain.stdout).toContain("1 archived task hidden");

    const all = await run(["search", "cliword", "-a"]);
    expect(all.stdout).toContain(old);
    expect(all.stdout).toContain("archived");
  });

  test("prints the daemon's own refusal for an empty query", async () => {
    writeConfig(18710);
    server = await serve({ port: 0, proseBackfill: false });
    writeConfig(server.port);

    const out = await run(["search", "   "]);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
  });
});
