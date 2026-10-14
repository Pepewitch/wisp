import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_DIR, isCaptureChrome, sweepCaptureBrowsers } from "../src/capture/chrome";
import { processGroupAlive } from "../src/process-tree";

/** A disposable process group leader; `profile` puts the capture browser's flag on its command line. */
function leader(profile?: string) {
  const args = profile ? ["sh", "-c", "sleep 30; true", "capture-chrome", `--user-data-dir=${profile}`] : ["sleep", "30"];
  return Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
}

describe("the boot sweep of capture browsers", () => {
  test("a recorded browser that is still ours is stopped, and its profile and record go", async () => {
    mkdirSync(BROWSER_DIR, { recursive: true });
    const profile = join(BROWSER_DIR, "cours");
    mkdirSync(profile);
    const child = leader(profile);
    writeFileSync(join(BROWSER_DIR, "cours.pgid"), String(child.pid));
    expect(isCaptureChrome(child.pid, profile)).toBe(true);
    await sweepCaptureBrowsers();
    await child.exited;
    expect(processGroupAlive(child.pid)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(BROWSER_DIR, "cours.pgid"))).toBe(false);
  });

  test("a recorded pid now used by something else is left running; only the record goes", async () => {
    mkdirSync(BROWSER_DIR, { recursive: true });
    const stranger = leader();
    writeFileSync(join(BROWSER_DIR, "creused.pgid"), String(stranger.pid));
    try {
      await sweepCaptureBrowsers();
      expect(processGroupAlive(stranger.pid)).toBe(true);
      expect(existsSync(join(BROWSER_DIR, "creused.pgid"))).toBe(false);
    } finally {
      stranger.kill();
      await stranger.exited;
    }
  });
});
