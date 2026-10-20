/**
 * A turn that ended on the network, told apart from every other failure
 * (adapters/network.ts), from each builtin's real offline words
 * (fixtures/network-outages.json) read through its own error strategy and
 * settled by turn-finalize.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ADAPTERS, errorDetail, isNetworkDetail, isNetworkFailure, type AdapterDef } from "../src/adapters";
import { recordKillReason } from "../src/runner";
import { createTask, createTurn, db, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { finalizeTurn } from "../src/turn-finalize";

const OUTAGES = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "network-outages.json"), "utf8")) as Record<string, { exit: number; stdout: string; stderr: string }>;
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const created: string[] = [];
afterEach(() => { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); });

/** Settle one failed turn from these logs, as the runner would, and return the task. */
async function settle(def: AdapterDef, exit: number | null, out: string, err: string, pre?: (turnId: number) => void) {
  const id = newTaskId();
  createTask({ id, title: "network fixture", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
  created.push(id);
  const dir = mkdtempSync(join(tmpdir(), "wisp-network-"));
  setTaskFields(id, { worktree_path: dir });
  transition(id, "running", "turn 1");
  const outPath = join(dir, "turn.out.log"), errPath = join(dir, "turn.err.log");
  writeFileSync(outPath, out);
  writeFileSync(errPath, err);
  const turnId = createTurn(id, 1, "prompt", 99999, outPath);
  pre?.(turnId);
  await finalizeTurn(id, turnId, def, exit, outPath, errPath);
  return getTask(id)!;
}

describe("each harness's offline words", () => {
  const cases = Object.entries(OUTAGES);

  test("the fixture covers every builtin, for a refused connection and a failed DNS lookup", () => {
    const harnesses = Object.keys(BUILTIN_ADAPTERS).filter((name) => name !== "fake").sort();
    expect(cases.map(([name]) => name).sort()).toEqual(harnesses.flatMap((name) => [`${name}-dns`, `${name}-refused`]).sort());
  });

  for (const [name, capture] of cases) {
    const def = BUILTIN_ADAPTERS[name.split("-")[0]!]!;
    test(`${name}: classified from the detail its own error strategy extracts`, () => {
      const detail = errorDetail(def, capture.stdout, capture.stderr);
      expect(detail).not.toBeNull();
      expect(isNetworkFailure(detail, capture.exit)).toBe(true);
    });

    test(`${name}: the failed task's detail starts "network: "`, async () => {
      const task = await settle(def, capture.exit, capture.stdout, capture.stderr);
      expect(task.state).toBe("failed");
      expect(task.state_detail).toStartWith("network: turn ");
      expect(isNetworkDetail(task.state_detail)).toBe(true);
    });
  }

  test("the words people saw in the outage", () => {
    expect(OUTAGES["claude-dns"]!.stdout).toContain("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)");
    expect(OUTAGES["claude-refused"]!.stdout).toContain("API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)");
  });
});

describe("never a network pause", () => {
  test("other failures: a real error, an unknown model, a bad request", async () => {
    expect((await settle(BUILTIN_ADAPTERS.droid!, 1, `{"type":"error","message":"disk on fire"}\n`, "")).state_detail).toBe("turn exited 1: disk on fire");
    const claude = await settle(BUILTIN_ADAPTERS.claude!, 1, fixture("claude-unknown-model.jsonl"), "");
    expect(isNetworkDetail(claude.state_detail)).toBe(false);
    const codex = await settle(BUILTIN_ADAPTERS.codex!, 1, fixture("codex-failed-turn.jsonl"), "");
    expect(isNetworkDetail(codex.state_detail)).toBe(false);
  });

  test("auth, quota and limits, even beside network words", () => {
    for (const detail of [
      "API Error: 401 Unauthorized",
      "Invalid API key · Please run /login",
      "OAuth token has expired; ECONNRESET while refreshing it",
      "connect ECONNREFUSED: authentication failed",
      "Cannot connect to API: 403 Forbidden",
      "Connection error. You've hit your usage limit",
      "Rate limit exceeded (429) after ECONNRESET",
      "insufficient_quota: ETIMEDOUT",
    ]) expect({ detail, network: isNetworkFailure(detail, 1) }).toEqual({ detail, network: false });
  });

  test("a turn that died to a signal, or whose exit Wisp never saw", () => {
    expect(isNetworkFailure("read ECONNRESET", 1)).toBe(true);
    expect(isNetworkFailure("read ECONNRESET", 137)).toBe(false);
    expect(isNetworkFailure("read ECONNRESET", null)).toBe(false);
    expect(isNetworkFailure(null, 1)).toBe(false);
  });

  test("a usage limit keeps its own prefix: limit wins", async () => {
    const task = await settle(BUILTIN_ADAPTERS.opencode!, 1, fixture("opencode-quota-exhausted.jsonl"), "");
    expect(task.state_detail).toStartWith("limit: ");
  });

  test("a turn Wisp killed is never a network pause, whatever its last words", async () => {
    const task = await settle(BUILTIN_ADAPTERS.droid!, 1, OUTAGES["droid-refused"]!.stdout, "", (turnId) => recordKillReason(turnId, "log cap exceeded (test)"));
    expect(task.state_detail).toBe("turn killed: log cap exceeded (test)");
  });
});
