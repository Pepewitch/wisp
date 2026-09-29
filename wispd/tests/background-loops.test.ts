/**
 * A failed background pass is logged with its reason and the loop carries on.
 * Stuck detection and webhook delivery used to lose the error completely (a
 * tracked rejection counts as handled), and the autopilot and workflow ticks
 * logged a fixed sentence without the error.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AutopilotRuntime } from "../src/autopilot/runtime";
import { loadConfig } from "../src/config";
import { FAILURE_REPEAT_REPORT_MS, logFailure } from "../src/failure-log";
import { backgroundPass, HomeLifetime } from "../src/home-lifetime";
import { WorkflowRuntime } from "../src/workflows/runtime";
import { fakeGitHub } from "./autopilot-harness";

let logged: Mock<(...args: unknown[]) => void>;
beforeEach(() => {
  logged = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => logged.mockRestore());

const lines = (): string[] => logged.mock.calls.map((call) => String(call[0]));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("backgroundPass", () => {
  test("a rejected pass is logged with its label and stack, and resolves", async () => {
    await backgroundPass("stuck detection", async () => {
      throw new Error("no such column: stuck_at");
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith("[wisp] stuck detection failed: Error: no such column: stuck_at");
    expect(lines()[0]).toContain("background-loops.test.ts");
  });

  test("a synchronous throw is a failed pass too, not an escaped exception", async () => {
    await backgroundPass("webhook delivery", () => {
      throw new Error("thrown before the first await");
    });
    expect(lines()[0]).toStartWith("[wisp] webhook delivery failed: Error: thrown before the first await");
  });

  test("the pass is home work: a draining owner waits for it", async () => {
    const lifetime = new HomeLifetime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    void lifetime.run(() => backgroundPass("slow pass", () => gate.then(() => { settled = true; })));
    const drained = lifetime.drain();
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release();
    await drained;
    expect(settled).toBe(true);
  });
});

describe("logFailure", () => {
  test("the first failure is logged in full, repeats are counted and summarized, not each logged", () => {
    const start = 1_000_000;
    const failure = new Error("database is locked (dedupe test)");
    logFailure("dedupe check failed", failure, start);
    for (let pass = 1; pass <= 5; pass++) logFailure("dedupe check failed", failure, start + pass * 10_000);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith("[wisp] dedupe check failed: Error: database is locked (dedupe test)");
    expect(lines()[0]).toContain("background-loops.test.ts"); // the stack, once

    logFailure("dedupe check failed", failure, start + FAILURE_REPEAT_REPORT_MS);
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toBe("[wisp] dedupe check failed: repeated 6 more times in the last 10 min: database is locked (dedupe test)");

    // another message, or another label, is another failure
    logFailure("dedupe check failed", new Error("disk full (dedupe test)"), start + FAILURE_REPEAT_REPORT_MS);
    logFailure("other check failed", failure, start + FAILURE_REPEAT_REPORT_MS);
    expect(lines()).toHaveLength(4);
  });

  test("a rejection reason that cannot be stringified is still logged", () => {
    logFailure("odd reason", { toString: 1 });
    expect(lines()).toEqual(['[wisp] odd reason: {"toString":1}']);
  });
});

/**
 * `HomeLifetime.track` marks a rejection as handled, so `void
 * trackHomeWork(x)` with no `.catch` loses a failure without a trace (a turn
 * watcher failing that way left its turn `running` with nothing in the log).
 * Every detached, tracked chain goes through `backgroundPass` or carries its
 * own `.catch`.
 */
test("no detached home-work chain in the daemon drops its failure", () => {
  const root = join(import.meta.dir, "../src");
  const offenders: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/void\s+(?:trackHomeWork|[A-Za-z_.]+\.track)\(/g)) {
      // find the call's closing paren, then require a .catch on it
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")" && --depth === 0) break;
      }
      if (!/^\s*\.catch\(/.test(source.slice(end + 1))) {
        offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

describe("runtime ticks", () => {
  test("a failed autopilot check logs why", async () => {
    const runtime = new AutopilotRuntime(loadConfig(), {}, { github: fakeGitHub().github });
    runtime.tick = () => Promise.reject(new Error("database is locked"));
    runtime.start();
    try {
      await until(() => lines().length > 0, "the failed check to be logged");
      expect(lines()[0]).toStartWith("[wisp] autopilot check failed: Error: database is locked");
    } finally {
      await runtime.stop();
    }
  });

  test("a failed workflow scheduler pass logs why", async () => {
    const runtime = new WorkflowRuntime(loadConfig(), {});
    runtime.tick = () => Promise.reject(new Error("disk I/O error"));
    runtime.start();
    try {
      await until(() => lines().length > 0, "the failed pass to be logged");
      expect(lines()[0]).toStartWith("[wisp] workflow scheduler failed: Error: disk I/O error");
    } finally {
      await runtime.stop();
    }
  });
});
