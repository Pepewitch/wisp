/**
 * Waiting on a page while watching the daemon that serves it.
 *
 * A browser-security run once failed as "timed out after 20000ms waiting for
 * home-screen authentication". The daemon under test had crashed nine seconds
 * earlier, so the page reached a dead origin and the harness waited out the
 * timeout for a dialog that could never render. The error named the symptom
 * rather than the cause. Every wait here checks the daemon on each poll, so a
 * crash fails at once, naming the signal or exit code.
 *
 * Kept apart from browser-security-check.ts, which runs on import, so the
 * behaviour has a unit test.
 */

export class DaemonExitedError extends Error {}

/** `signal SIGSEGV` or `code 1` once the process has exited, else null. */
export function exitDescription(process: Bun.Subprocess): string | null {
  if (process.signalCode) return `signal ${process.signalCode}`;
  if (process.exitCode !== null) return `code ${process.exitCode}`;
  return null;
}

let watched: Bun.Subprocess | null = null;

/** The daemon every later wait checks. `null` stops watching, as teardown does. */
export function watchDaemon(daemon: Bun.Subprocess | null): void {
  watched = daemon;
}

export function assertDaemonAlive(what: string): void {
  const exit = watched && exitDescription(watched);
  if (exit) throw new DaemonExitedError(`the scratch daemon exited (${exit}) while waiting for ${what}`);
}

export interface Evaluates {
  evaluate(expression: string): Promise<unknown>;
}

/**
 * Wait for a page to satisfy `predicate` (a JS expression), instead of
 * sleeping at it. The old fixed sleeps were fine while CI was fast and are
 * exactly what makes a check like this flake later (a review's note).
 */
export async function waitInPage(page: Evaluates, predicate: string, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    assertDaemonAlive(what);
    if ((await page.evaluate(predicate)) === true) return;
    if (Date.now() > deadline) {
      // A daemon that died during the last poll is the cause, not the timeout.
      assertDaemonAlive(what);
      throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    }
    await Bun.sleep(100);
  }
}
