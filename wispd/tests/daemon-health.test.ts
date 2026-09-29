/**
 * What the daemon keeps so that its own trouble is visible afterwards: the run
 * marker an unclean exit leaves behind, each background loop's latest outcome,
 * timestamps on its log lines, and the failed-authentication throttle.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginDaemonRun, endDaemonRun, MAX_RECORDED_EXITS, recentUncleanExits, uncleanExits } from "../src/daemon-run";
import { installLogTimestamps } from "../src/failure-log";
import { backgroundPass, loopHealth } from "../src/home-lifetime";
import { AuthThrottle } from "../src/routes/auth";
import { diagnosticsRoute } from "../src/routes/diagnostics";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function paths() {
  const home = mkdtempSync(join(tmpdir(), "wisp-daemon-run-"));
  homes.push(home);
  return { run: join(home, "daemon-run.json"), exits: join(home, "daemon-exits.json") };
}

describe("the run marker", () => {
  test("a graceful stop removes it, so the next boot finds nothing to report", () => {
    const at = paths();
    const lines: string[] = [];
    const { run, previous } = beginDaemonRun(new Date("2026-09-01T10:00:00Z"), at, (line) => lines.push(line));
    expect(previous).toBeNull();
    expect(JSON.parse(readFileSync(at.run, "utf8"))).toEqual({ pid: process.pid, startedAt: "2026-09-01T10:00:00.000Z", version: run.version });
    endDaemonRun(run, at);
    expect(existsSync(at.run)).toBe(false);

    expect(beginDaemonRun(new Date("2026-09-01T10:05:00Z"), at, (line) => lines.push(line)).previous).toBeNull();
    expect(lines).toEqual([]);
    expect(uncleanExits(at.exits)).toEqual([]);
  });

  test("a marker left behind is logged and recorded as an unclean exit", () => {
    const at = paths();
    writeFileSync(at.run, JSON.stringify({ pid: 4242, startedAt: "2026-09-01T09:00:00.000Z", version: "0.6.0" }));
    const lines: string[] = [];
    const { previous } = beginDaemonRun(new Date("2026-09-01T09:30:00Z"), at, (line) => lines.push(line));

    expect(previous).toEqual({ pid: 4242, startedAt: "2026-09-01T09:00:00.000Z", version: "0.6.0" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[wisp] the previous daemon (pid 4242, 0.6.0, started 2026-09-01T09:00:00.000Z) exited without shutting down");
    expect(lines[0]).toContain("1 unclean exit in the last hour");
    expect(uncleanExits(at.exits)).toEqual([
      { pid: 4242, startedAt: "2026-09-01T09:00:00.000Z", version: "0.6.0", detectedAt: "2026-09-01T09:30:00.000Z" },
    ]);
  });

  test("only the most recent unclean exits are kept, and the window picks the recent ones", () => {
    const at = paths();
    const start = Date.parse("2026-09-01T00:00:00Z");
    for (let boot = 0; boot < MAX_RECORDED_EXITS + 3; boot++) {
      // each boot finds the one before it still marked: a crash loop
      beginDaemonRun(new Date(start + boot * 10 * 60_000), at, () => {});
    }
    const exits = uncleanExits(at.exits);
    expect(exits).toHaveLength(MAX_RECORDED_EXITS);
    const last = new Date(start + (MAX_RECORDED_EXITS + 2) * 10 * 60_000);
    expect(recentUncleanExits(exits, last, 60 * 60_000)).toHaveLength(7);
  });

  test("a stop never removes a successor's marker", () => {
    const at = paths();
    const { run: first } = beginDaemonRun(new Date("2026-09-01T10:00:00Z"), at, () => {});
    const { run: second } = beginDaemonRun(new Date("2026-09-01T10:01:00Z"), at, () => {});
    endDaemonRun(first, at);
    expect(JSON.parse(readFileSync(at.run, "utf8")).startedAt).toBe(second.startedAt);
  });
});

describe("background loop health", () => {
  test("a loop pass records its outcome; a per-task chain records nothing", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await backgroundPass("health test loop", async () => { throw new Error("database is locked"); }, { loop: true });
      await backgroundPass("health test loop", async () => { throw new Error("database is locked"); }, { loop: true });
      let entry = loopHealth().find((loop) => loop.name === "health test loop")!;
      expect(entry.consecutiveFailures).toBe(2);
      expect(entry.lastError).toBe("database is locked");
      expect(entry.lastSuccessAt).toBeNull();

      await backgroundPass("health test loop", async () => {}, { loop: true });
      entry = loopHealth().find((loop) => loop.name === "health test loop")!;
      expect(entry.consecutiveFailures).toBe(0);
      expect(entry.lastSuccessAt).not.toBeNull();
      expect(entry.lastError).toBe("database is locked"); // still says why it last failed

      await backgroundPass("a one-off chain", async () => {});
      expect(loopHealth().some((loop) => loop.name === "a one-off chain")).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });

  test("GET /api/diagnostics reports the loops and the webhook summary", async () => {
    await backgroundPass("diagnostics test loop", async () => {}, { loop: true });
    const report = (await diagnosticsRoute().json()) as {
      pid: number;
      loops: { name: string }[];
      webhooks: { failing: number; dead: number };
    };
    expect(report.pid).toBe(process.pid);
    expect(report.loops.map((loop) => loop.name)).toContain("diagnostics test loop");
    expect(typeof report.webhooks.failing).toBe("number");
    expect(typeof report.webhooks.dead).toBe("number");
  });
});

describe("daemon log timestamps", () => {
  test("every line gets an ISO timestamp in front of its [wisp] tag, and formatting still works", () => {
    const written: unknown[][] = [];
    const record = (...args: unknown[]) => { written.push(args); };
    const target = { log: record, info: record, warn: record, error: record };
    installLogTimestamps(target, () => new Date("2026-09-01T12:34:56.789Z"));
    installLogTimestamps(target, () => new Date("2030-01-01T00:00:00.000Z")); // once only

    target.error("[wisp] webhook delivery: HTTP 500");
    target.warn("[wisp] %s refused", "terminal upgrade");
    target.log({ not: "a string" });

    expect(written).toEqual([
      ["2026-09-01T12:34:56.789Z [wisp] webhook delivery: HTTP 500"],
      ["2026-09-01T12:34:56.789Z [wisp] %s refused", "terminal upgrade"],
      ["2026-09-01T12:34:56.789Z", { not: "a string" }],
    ]);
  });
});

describe("the failed-authentication throttle", () => {
  test("free failures, then a wait that doubles to its ceiling, forgotten after a quiet spell", () => {
    let now = 0;
    const throttle = new AuthThrottle({ freeFailures: 3, baseDelayMs: 1_000, maxDelayMs: 4_000, forgetMs: 60_000, now: () => now });
    throttle.failed("a");
    throttle.failed("a");
    expect(throttle.retryAfterMs("a")).toBe(0);
    throttle.failed("a");
    expect(throttle.retryAfterMs("a")).toBe(1_000);
    expect(throttle.retryAfterMs("b")).toBe(0); // per address
    now += 1_000;
    throttle.failed("a");
    expect(throttle.retryAfterMs("a")).toBe(2_000);
    now += 2_000;
    throttle.failed("a");
    expect(throttle.retryAfterMs("a")).toBe(4_000);
    now += 4_000;
    throttle.failed("a");
    expect(throttle.retryAfterMs("a")).toBe(4_000); // the ceiling
    now += 60_000;
    expect(throttle.retryAfterMs("a")).toBe(0);
    throttle.failed("a"); // forgotten: a fresh allowance
    expect(throttle.retryAfterMs("a")).toBe(0);
  });

  test("remembers a bounded number of addresses", () => {
    const throttle = new AuthThrottle({ freeFailures: 1, maxAddresses: 2, now: () => 0 });
    throttle.failed("a");
    throttle.failed("b");
    throttle.failed("c"); // forgets "a", the least recently failed
    expect(throttle.retryAfterMs("a")).toBe(0);
    expect(throttle.retryAfterMs("b")).toBeGreaterThan(0);
    expect(throttle.retryAfterMs("c")).toBeGreaterThan(0);
  });
});
