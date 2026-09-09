/**
 * The bounded subprocess runner (ENG-05 / SEC-05).
 *
 * Two things had no limit at all: output was buffered in full before any cap
 * looked at its size, and nothing had a deadline. Both are asserted here with
 * real children — a producer that would out-write any buffer, and a command
 * that never exits — because the whole point is what happens to memory and to
 * the daemon's attention, which a mocked spawn cannot show.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Coalescer, runBounded, Semaphore } from "../src/subprocess";

describe("runBounded", () => {
  test("returns output, exit code, and stderr for an ordinary command", async () => {
    const result = await runBounded({ cmd: ["bash", "-c", "echo out; echo err >&2; exit 3"] });
    expect(result.exitCode).toBe(3);
    expect(result.out.trim()).toBe("out");
    expect(result.err.trim()).toBe("err");
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  /**
   * `yes` produces indefinitely. Buffering it would consume memory until
   * something died, so the assertion is that the call RETURNS, with a result
   * the size of the budget — not that some cap was applied afterwards.
   */
  test("stops reading at the byte budget and kills the producer", async () => {
    const before = Date.now();
    const result = await runBounded({ cmd: ["bash", "-c", "yes wisp"], maxBytes: 64 * 1024, timeoutMs: 15_000 });
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.out.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.out.startsWith("wisp\n")).toBe(true);
    // it did not wait out the deadline to get there
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 30_000);

  test("a command that never exits is stopped at its deadline and says so", async () => {
    const before = Date.now();
    const result = await runBounded({ cmd: ["sleep", "60"], timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 20_000);

  /** A hung child's descendants have to go too, or the deadline frees nothing. */
  test("the deadline reaches what the command started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-bounded-tree-"));
    const pidFile = join(dir, "child.pid");
    const result = await runBounded({
      cmd: ["bash", "-c", `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`],
      timeoutMs: 700,
    });
    expect(result.timedOut).toBe(true);
    const pid = Number(await Bun.file(pidFile).text());
    const deadline = Date.now() + 5_000;
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    while (alive() && Date.now() < deadline) await Bun.sleep(50);
    expect(alive()).toBe(false);
  }, 20_000);

  test("an aborted caller cancels the run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runBounded({ cmd: ["sleep", "60"], timeoutMs: 30_000, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  test("multi-byte output is not mangled at a chunk boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wisp-bounded-utf8-"));
    const file = join(dir, "utf8.txt");
    writeFileSync(file, "é".repeat(5_000));
    const result = await runBounded({ cmd: ["cat", file] });
    expect(result.out).toBe("é".repeat(5_000));
    expect(result.truncated).toBe(false);
  });

  test("stderr has its own budget, so a noisy failure cannot be unbounded either", async () => {
    const result = await runBounded({
      cmd: ["bash", "-c", "yes 'noise' >&2"],
      maxErrorBytes: 8 * 1024,
      timeoutMs: 15_000,
    });
    expect(result.err.length).toBeLessThanOrEqual(8 * 1024);
  }, 30_000);

  /**
   * A chatty stderr is noise, not failure. Killing an otherwise-succeeding
   * command over it would turn a verbose hook into a failed task (a review's
   * note) — and simply stopping the read would be worse, because the child
   * then blocks forever on a pipe nobody drains. Past the budget the reader
   * keeps reading and discards.
   */
  test("a command that over-writes stderr still succeeds, with a stderr prefix", async () => {
    const before = Date.now();
    const result = await runBounded({
      cmd: ["bash", "-c", "for i in $(seq 1 4000); do echo 'chatty hook line' >&2; done; echo done"],
      maxErrorBytes: 4 * 1024,
      timeoutMs: 15_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.out.trim()).toBe("done");
    expect(result.err.length).toBeLessThanOrEqual(4 * 1024);
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 30_000);
});

describe("Semaphore", () => {
  test("never runs more than its limit at once, and runs everything", async () => {
    const gate = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        gate.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active -= 1;
          return index;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(20);
  });

  test("a thrown task releases its slot", async () => {
    const gate = new Semaphore(1);
    await expect(gate.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(() => Promise.resolve("after"))).toBe("after");
  });
});

describe("Coalescer", () => {
  test("overlapping callers share one run; a later caller starts a new one", async () => {
    const coalescer = new Coalescer<number>();
    let runs = 0;
    const work = async (): Promise<number> => {
      runs += 1;
      await Bun.sleep(20);
      return runs;
    };

    const [first, second] = await Promise.all([coalescer.run(work), coalescer.run(work)]);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(runs).toBe(1);

    expect(await coalescer.run(work)).toBe(2);
    expect(runs).toBe(2);
  });

  test("a failed run is not cached", async () => {
    const coalescer = new Coalescer<string>();
    await expect(coalescer.run(() => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(await coalescer.run(() => Promise.resolve("fresh"))).toBe("fresh");
  });
});
