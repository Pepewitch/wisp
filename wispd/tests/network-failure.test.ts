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
import { CodexLiveDriver } from "../src/adapters/live/codex";
import { DroidLiveDriver } from "../src/adapters/live/droid";
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

  test("a turn that died to a signal", () => {
    expect(isNetworkFailure("read ECONNRESET", 1)).toBe(true);
    expect(isNetworkFailure("read ECONNRESET", 137)).toBe(false);
    expect(isNetworkFailure(null, 1)).toBe(false);
  });

  test("a usage limit keeps its own prefix: limit wins", async () => {
    const task = await settle(BUILTIN_ADAPTERS.opencode!, 1, fixture("opencode-quota-exhausted.jsonl"), "");
    expect(task.state_detail).toStartWith("limit: ");
  });

  test("a turn whose exit Wisp never saw is judged by its words", async () => {
    // a live turn settled while its process lingers, or one recovered after a restart
    expect(isNetworkFailure("read ECONNRESET", null)).toBe(true);
    const task = await settle(BUILTIN_ADAPTERS.droid!, null, OUTAGES["droid-refused"]!.stdout, "");
    expect(task.state_detail).toStartWith("network: ");
  });

  test("a turn Wisp killed is never a network pause, whatever its last words", async () => {
    const task = await settle(BUILTIN_ADAPTERS.droid!, 1, OUTAGES["droid-refused"]!.stdout, "", (turnId) => recordKillReason(turnId, "log cap exceeded (test)"));
    expect(task.state_detail).toBe("turn killed: log cap exceeded (test)");
  });
});

describe("a live transport that broke on the harness's words", () => {
  // turn-process.ts failLiveTurn records the harness's refusal as the kill reason, then signals the process
  test("a refused setup that names a dropped connection is a network pause", async () => {
    const task = await settle(BUILTIN_ADAPTERS.codex!, 143, "", "", (turnId) =>
      recordKillReason(turnId, "live input setup failed: error sending request for url (https://provider.example.invalid/v1/responses)"));
    expect(task.state_detail).toStartWith("network: turn killed: live input setup failed: ");
  });

  test("a broken pipe, or a refusal for another reason, is not", async () => {
    const pipe = await settle(BUILTIN_ADAPTERS.droid!, 143, "", "", (turnId) => recordKillReason(turnId, "live output pump failed: EPIPE: broken pipe"));
    expect(isNetworkDetail(pipe.state_detail)).toBe(false);
    const auth = await settle(BUILTIN_ADAPTERS.codex!, 143, "", "", (turnId) =>
      recordKillReason(turnId, "live input setup failed: 401 Unauthorized: ECONNRESET while refreshing the token"));
    expect(isNetworkDetail(auth.state_detail)).toBe(false);
  });
});

describe("the live protocols Wisp runs codex and droid through", () => {
  const LIVE = JSON.parse(fixture("network-live-frames.json")) as Record<string, Record<string, unknown>[]>;

  /**
   * Replay what the harness sent back, through Wisp's own driver: each
   * response waits for the request it answers. Returns the turn log the
   * driver wrote, line for line.
   */
  async function replay(frames: Record<string, unknown>[], start: (sink: { write(d: string): void; flush(): void; end(): void }, emit: (e: unknown) => void, done: () => void) => { handle(frame: unknown): void; close(): Promise<void> }) {
    const sent: string[] = [], log: string[] = [];
    let terminal = false;
    const driver = start({ write: (d) => sent.push(d), flush() {}, end() {} }, (event) => log.push(JSON.stringify(event)), () => { terminal = true; });
    for (const frame of frames) {
      if ("id" in frame && !("method" in frame)) {
        await until(() => sent.some((line) => (JSON.parse(line) as { id?: unknown }).id === frame.id), `request ${String(frame.id)}`);
      }
      driver.handle(frame);
    }
    expect(terminal).toBe(true);
    await driver.close();
    return `${log.join("\n")}\n`;
  }

  async function until(check: () => boolean, what: string) {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  }

  const common = { cwd: "/fixture/repo", sessionId: null, model: null, effort: null, initialMessageId: "m-offline" };

  test("codex app-server: the failed turn's detail is codex's own words, and a network pause", async () => {
    const def = BUILTIN_ADAPTERS.codex!;
    const out = await replay(LIVE["codex-dns"]!, (sink, emit, done) => new CodexLiveDriver({
      ...common, sink, def, fast: false, emit, onTerminal: done, initialInput: [{ type: "text", text: "say hi", text_elements: [] }],
    }));
    expect(errorDetail(def, out, "")).toBe("workspace routing discovery failed");
    // a live turn settled while app-server lingers has no exit of its own
    expect((await settle(def, null, out, "")).state_detail).toBe("network: turn exited unknown: workspace routing discovery failed");
  });

  test("droid JSON-RPC: the turn ends model_provider_unreachable, and that is a network pause", async () => {
    const def = BUILTIN_ADAPTERS.droid!;
    const out = await replay(LIVE["droid-refused"]!, (sink, emit, done) => new DroidLiveDriver({
      ...common, sink, def, emit, onTerminal: done, initialText: "say hi", initialImages: [],
    }));
    expect(errorDetail(def, out, "")).toBe("Droid turn model_provider_unreachable");
    expect(isNetworkDetail((await settle(def, 0, out, "")).state_detail)).toBe(true);
  });
});
