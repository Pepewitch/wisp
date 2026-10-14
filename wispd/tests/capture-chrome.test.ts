import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_DIR, isCaptureChrome, sweepCaptureBrowsers } from "../src/capture/chrome";
import { servedFrom } from "../src/capture/served-from";
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

describe("where a captured page was served from", () => {
  test("a listener running in the worktree is the worktree's; anywhere else is elsewhere; a closed port is unknown", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const port = server.port!;
    try {
      // this test process is the listener: its working directory decides
      expect(await servedFrom(port, process.cwd())).toBe("worktree");
      expect(await servedFrom(port, mkdtempSync(join(tmpdir(), "wisp-not-the-worktree-")))).toBe("elsewhere");
      expect(await servedFrom(port, null)).toBe("unknown");
    } finally {
      server.stop(true);
    }
    expect(await servedFrom(port, process.cwd())).toBe("unknown");
  });
});
