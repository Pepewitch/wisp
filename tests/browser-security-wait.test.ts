/**
 * A crash of the daemon under the browser check must fail the check at once,
 * named as a crash, instead of surfacing twenty seconds later as a page that
 * never rendered.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { DaemonExitedError, exitDescription, waitInPage, watchDaemon } from "../scripts/browser-security-wait";

const neverReady = { evaluate: async () => false };

afterEach(() => watchDaemon(null));

describe("waiting on the page while the daemon runs", () => {
  test("fails as soon as the daemon dies from a signal, naming the signal and the wait", async () => {
    const daemon = Bun.spawn(["/bin/sh", "-c", "sleep 0.3; kill -SEGV $$"]);
    watchDaemon(daemon);
    const started = Date.now();
    const error = await waitInPage(neverReady, "false", "home-screen authentication").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonExitedError);
    expect((error as Error).message).toBe(
      "the scratch daemon exited (signal SIGSEGV) while waiting for home-screen authentication",
    );
    // The page timeout is 20 s; the crash is reported within a poll or two.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("names an exit code the same way", async () => {
    const daemon = Bun.spawn(["/bin/sh", "-c", "exit 3"]);
    await daemon.exited;
    watchDaemon(daemon);
    expect(exitDescription(daemon)).toBe("code 3");
    await expect(waitInPage(neverReady, "false", "the app to render")).rejects.toThrow(
      "the scratch daemon exited (code 3) while waiting for the app to render",
    );
  });

  test("still waits for the page, and still times out, while the daemon is alive", async () => {
    const daemon = Bun.spawn(["/bin/sh", "-c", "sleep 30"]);
    watchDaemon(daemon);
    try {
      let polls = 0;
      await waitInPage({ evaluate: async () => ++polls >= 2 }, "ready", "the page");
      expect(polls).toBe(2);
      await expect(waitInPage(neverReady, "false", "a dialog", 150)).rejects.toThrow(
        "timed out after 150ms waiting for a dialog",
      );
      expect(exitDescription(daemon)).toBeNull();
    } finally {
      daemon.kill();
      await daemon.exited;
    }
  });
});
