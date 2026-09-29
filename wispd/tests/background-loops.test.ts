/**
 * A failed background pass is logged with its reason and the loop carries on.
 * Stuck detection and webhook delivery used to lose the error completely (a
 * tracked rejection counts as handled), and the autopilot and workflow ticks
 * logged a fixed sentence without the error.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";

import { AutopilotRuntime } from "../src/autopilot/runtime";
import { loadConfig } from "../src/config";
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
