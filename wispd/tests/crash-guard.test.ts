/**
 * The daemon's last-resort handlers, observed from outside a real process:
 * Bun ends one on an unhandled rejection, and the daemon owns every live
 * terminal and in-flight request, so it logs and keeps serving instead. An
 * uncaught exception still ends it, loudly, for the service manager to restart.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function child(mode: "rejection" | "exception") {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/crash-guard-child.ts"), mode],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("daemon crash guards", () => {
  test("an unhandled rejection is logged with its stack and the process keeps running", async () => {
    const { stdout, stderr, code } = await child("rejection");
    expect(code).toBe(0);
    expect(stdout).toContain("still serving");
    expect(stderr).toContain("[wisp] unhandled promise rejection; the daemon keeps serving: Error: a stray rejection");
    expect(stderr).toContain("crash-guard-child.ts"); // the stack, not just the message
  });

  test("an uncaught exception is logged with its stack and ends the process", async () => {
    const { stdout, stderr, code } = await child("exception");
    expect(code).toBe(1);
    expect(stdout).not.toContain("still serving");
    expect(stderr).toContain("[wisp] uncaught exception; the daemon exits so its service manager restarts it: Error: a stray throw");
    expect(stderr).toContain("crash-guard-child.ts");
  });
});
