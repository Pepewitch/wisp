import { describe, expect, test } from "bun:test";

import { parseWait, settledCode, waitLine, waitOutcome } from "../src/cli-wait";
import type { ApiTask, BackgroundWork, TaskState } from "../src/types";

/**
 * `wisp wait`: when a snapshot of one or several tasks ends the wait, with
 * which exit code, and what it prints. The loop around it is a poll.
 */

const running: BackgroundWork = {
  state: "running",
  groups: 1,
  details: [{ turn: 1, pgid: 4242, processes: 2, since: null, state: "running", stopRequested: false, names: [], tasks: [{ name: "gh pr checks --watch", kind: "execute", turn: 1, since: "2026-11-02T00:00:00Z" }] }],
};

function task(id: string, state: TaskState, background?: BackgroundWork): ApiTask {
  return { id, state, state_detail: null, background: background ?? { state: "none", groups: 0, details: [] } } as unknown as ApiTask;
}

describe("one task", () => {
  test("ends on done, needs-input and failed with their exit codes; waits through running and stuck", () => {
    expect(waitOutcome([task("ta", "done")], "one", false)?.code).toBe(0);
    expect(waitOutcome([task("ta", "needs-input")], "one", false)?.code).toBe(2);
    expect(waitOutcome([task("ta", "failed")], "one", false)?.code).toBe(1);
    expect(waitOutcome([task("ta", "running")], "one", false)).toBeNull();
    expect(waitOutcome([task("ta", "stuck")], "one", false)).toBeNull();
  });

  test("done with its own background work running ends the wait, and the line says so", () => {
    const watching = task("ta", "done", running);
    expect(waitOutcome([watching], "one", false)?.code).toBe(0);
    expect(waitLine(watching)).toBe("ta  done · 1 background process running");
  });

  test("--settled keeps waiting while that work runs, and ends once it is gone", () => {
    expect(waitOutcome([task("ta", "done", running)], "one", true)).toBeNull();
    expect(waitOutcome([task("ta", "done", { ...running, state: "stopping" })], "one", true)).toBeNull();
    expect(waitOutcome([task("ta", "done")], "one", true)?.code).toBe(0);
  });

  test("--settled does not hold needs-input or failed, nor background work Wisp cannot see", () => {
    expect(settledCode(task("ta", "needs-input", running), true)).toBe(2);
    expect(settledCode(task("ta", "failed", running), true)).toBe(1);
    expect(settledCode(task("ta", "done", { ...running, state: "unknown" }), true)).toBe(0);
  });
});

describe("several tasks", () => {
  test("--any ends on the first settled task in the order given and reports only it", () => {
    const outcome = waitOutcome([task("ta", "running"), task("tb", "needs-input"), task("tc", "done")], "any", false);
    expect(outcome?.code).toBe(2);
    expect(outcome?.report.map(t => t.id)).toEqual(["tb"]);
    expect(waitOutcome([task("ta", "running"), task("tb", "stuck")], "any", false)).toBeNull();
  });

  test("--any with --settled skips a done task whose background work still runs", () => {
    const outcome = waitOutcome([task("ta", "done", running), task("tb", "running")], "any", true);
    expect(outcome).toBeNull();
  });

  test("--all waits for every task and exits with the most serious code", () => {
    expect(waitOutcome([task("ta", "done"), task("tb", "running")], "all", false)).toBeNull();
    expect(waitOutcome([task("ta", "done"), task("tb", "done")], "all", false)?.code).toBe(0);
    expect(waitOutcome([task("ta", "needs-input"), task("tb", "done")], "all", false)?.code).toBe(2);
    const outcome = waitOutcome([task("ta", "needs-input"), task("tb", "failed"), task("tc", "done")], "all", false);
    expect(outcome?.code).toBe(1);
    expect(outcome?.report.map(t => t.id)).toEqual(["ta", "tb", "tc"]);
  });
});

describe("arguments", () => {
  test("one task waits on it; several default to --all; --any opts into the first", () => {
    expect(parseWait(["ta"], {})).toMatchObject({ ids: ["ta"], mode: "one", settled: false, timeoutSec: 86_400 });
    expect(parseWait(["ta", "tb"], {})).toMatchObject({ mode: "all" });
    expect(parseWait(["ta", "tb"], { any: true })).toMatchObject({ mode: "any" });
    expect(parseWait(["ta"], { settled: true, timeout: "30" })).toMatchObject({ settled: true, timeoutSec: 30 });
    expect(parseWait(["ta", "ta", "tb"], {})).toMatchObject({ ids: ["ta", "tb"] });
  });

  test("refuses no task, --any with --all, and a bad --timeout", () => {
    expect(parseWait([], {})).toContain("usage:");
    expect(parseWait(["ta", "tb"], { any: true, all: true })).toBe("--any and --all cannot be combined");
    expect(parseWait(["ta"], { timeout: true })).toContain("--timeout must be a positive number");
    expect(parseWait(["ta"], { timeout: "0" })).toContain("--timeout must be a positive number");
    expect(parseWait(["ta"], { timeout: "soon" })).toContain("--timeout must be a positive number");
  });
});
