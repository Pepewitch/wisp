import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded, Semaphore, type RunOptions } from "../src/subprocess";
import { CommandGroup } from "../src/command-group";

const fixtures: { dir: string; watchdog: ReturnType<typeof setTimeout> }[] = [];
function pid(dir: string, name: string): number | null {
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  const value = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(value) && value > 1 ? value : null;
}
function alive(value: number | null): boolean {
  if (value === null) return false;
  try { process.kill(value, 0); return true; } catch { return false; }
}
function cleanup(dir: string): void {
  for (const file of ["leader.pid", "escaped.pid"]) {
    const value = pid(dir, file);
    if (value !== null) { try { process.kill(-value, "SIGKILL"); } catch { /* already ended */ } }
  }
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) { clearTimeout(fixture.watchdog); cleanup(fixture.dir); }
});

function fixture(script: string, options: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-command-lifetime-"));
  // An old implementation must fail the latency assertion, not leave its
  // descendant running after the test times out. Only synthetic owned groups.
  const watchdog = setTimeout(() => cleanup(dir), 6_000);
  fixtures.push({ dir, watchdog });
  const started = Date.now();
  const result = runBounded({ cmd: ["bash", "-c", `echo $$ > leader.pid\n${script}`], cwd: dir, timeoutMs: 300, ...options });
  return { dir, result, elapsed: () => Date.now() - started };
}
const resistant = (redirection = "") => [
  `sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' ${redirection} &`,
  "while [ ! -s child.pid ]; do sleep .01; done",
].join("\n");

describe("command deadlines include descendants and pipe readers", () => {
  test.each(["stdout", "stderr"])("a leader that exits before timeout cannot strand inherited %s", async (stream) => {
    const run = fixture(`${resistant(stream === "stderr" ? ">/dev/null" : "2>/dev/null")}\necho useful-prefix\necho diagnostic-prefix >&2\nexit 0`);
    const result = await run.result;
    expect(result.timedOut).toBe(true);
    expect(result.cleanupError).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("useful-prefix");
    expect(result.err).toContain("diagnostic-prefix");
    expect(run.elapsed()).toBeLessThan(4_500);
    expect(pid(run.dir, "child.pid")).not.toBeNull();
    expect(alive(pid(run.dir, "child.pid"))).toBe(false);
  }, 9_000);

  test("EOF after TERM does not cancel escalation for a resistant child with redirected pipes", async () => {
    const run = fixture(`${resistant(">/dev/null 2>&1")}\nwait`);
    const result = await run.result;
    expect(result.timedOut).toBe(true);
    expect(result.cleanupError).toBeUndefined();
    expect(run.elapsed()).toBeGreaterThanOrEqual(2_000);
    expect(run.elapsed()).toBeLessThan(4_500);
    expect(alive(pid(run.dir, "child.pid"))).toBe(false);
  }, 9_000);

  test("cancellation after leader exit settles the group without waiting for the command timeout", async () => {
    const controller = new AbortController();
    const run = fixture(`${resistant()}\nexit 0`, { signal: controller.signal, timeoutMs: 30_000 });
    const abort = setTimeout(() => controller.abort(), 250);
    try {
      const result = await run.result;
      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.cleanupError).toBeUndefined();
      expect(run.elapsed()).toBeLessThan(4_500);
      expect(alive(pid(run.dir, "child.pid"))).toBe(false);
    } finally { clearTimeout(abort); }
  }, 9_000);

  test("a stdout cap owns one cleanup even if abort and deadline arrive during the grace period", async () => {
    const controller = new AbortController();
    const run = fixture(`${resistant()}\nhead -c 4096 /dev/zero\nexit 0`, { maxBytes: 64, signal: controller.signal, timeoutMs: 500 });
    const abort = setTimeout(() => controller.abort(), 300);
    try {
      const result = await run.result;
      expect(result.truncated).toBe(true);
      expect(result.out.length).toBe(64);
      expect(result.timedOut).toBe(false);
      expect(result.cancelled).toBe(false);
      expect(result.cleanupError).toBeUndefined();
      expect(run.elapsed()).toBeLessThan(4_500);
      expect(alive(pid(run.dir, "child.pid"))).toBe(false);
    } finally { clearTimeout(abort); }
  }, 9_000);

  test("an already-aborted request never launches its command", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = fixture("echo should-not-run > launched", { signal: controller.signal });
    expect((await run.result).cancelled).toBe(true);
    expect(existsSync(join(run.dir, "leader.pid"))).toBe(false);
    expect(existsSync(join(run.dir, "launched"))).toBe(false);
  });

  test("an escaped pipe holder cannot hold EOF hostage or grant authority to kill outside the group", async () => {
    const script = `const child = Bun.spawn({cmd: ["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], stdout: "inherit", stderr: "inherit", detached: true});
      await Bun.write("escaped.pid", String(child.pid)); child.unref(); process.exit(0);`;
    const run = fixture('exec "$FIXTURE_BUN" -e "$FIXTURE_SCRIPT"', { env: { FIXTURE_BUN: process.execPath, FIXTURE_SCRIPT: script } });
    const result = await run.result;
    expect(result.timedOut).toBe(true);
    expect(result.cleanupError).toBeUndefined();
    expect(run.elapsed()).toBeLessThan(4_500);
    // Explicitly outside Wisp's group boundary. The test, not the supervisor,
    // owns its cleanup. Returning must not depend on this process closing EOF.
    expect(alive(pid(run.dir, "escaped.pid"))).toBe(true);
  }, 9_000);

  test("an unresponsive cleanup releases a semaphore slot and reports uncertainty", async () => {
    const inspect = spyOn(CommandGroup.prototype, "inspect").mockImplementation(() => new Promise(() => {}));
    const gate = new Semaphore(1);
    let run!: ReturnType<typeof fixture>;
    try {
      const first = gate.run(() => { run = fixture("sleep 60"); return run.result; });
      const next = gate.run(() => Promise.resolve("next request completed"));
      const result = await first;
      expect(result.timedOut).toBe(true);
      expect(result.cleanupError).toContain("cleanup incomplete");
      expect(run.elapsed()).toBeLessThan(4_500);
      expect(await next).toBe("next request completed");
      expect(alive(pid(run.dir, "leader.pid"))).toBe(true);
    } finally { inspect.mockRestore(); }
  }, 9_000);
});
