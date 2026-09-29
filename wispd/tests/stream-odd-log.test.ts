/**
 * One unexpected harness line used to end the daemon: opening that task's log
 * stream threw inside a fire-and-forget tick, Bun exits on an unhandled
 * rejection, and the web UI reopening the selected task after the restart
 * made it a crash loop. This drives a real daemon process, because "the
 * process is still alive" is only observable from outside it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSseReader } from "./helpers/sse-reader";

const home = mkdtempSync(join(tmpdir(), "wisp-odd-log-"));
const stderr = join(home, "daemon.err.log");
const headers = { authorization: "Bearer odd-log-fixture-token" };
let daemon: ReturnType<typeof Bun.spawn>;
let base = "";

function daemonLog(): string {
  return existsSync(stderr) ? readFileSync(stderr, "utf8").trim() : "";
}

beforeAll(async () => {
  daemon = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "fixtures/odd-log-daemon.ts")],
    env: { ...process.env, WISP_HOME: home },
    stdout: "ignore",
    stderr: Bun.file(stderr),
  });
  const ready = join(home, "ready.json");
  const deadline = Date.now() + 15_000;
  while (!existsSync(ready)) {
    if (daemon.exitCode !== null) throw new Error(`fixture daemon exited ${daemon.exitCode}:\n${daemonLog()}`);
    if (Date.now() > deadline) throw new Error(`fixture daemon never became ready:\n${daemonLog()}`);
    await Bun.sleep(50);
  }
  base = `http://127.0.0.1:${(JSON.parse(readFileSync(ready, "utf8")) as { port: number }).port}`;
});

afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
});

for (const format of ["human", "activity"] as const) {
  test(`streaming a log with malformed lines (${format}) renders it and leaves the daemon serving`, async () => {
    const res = await fetch(`${base}/api/tasks/toddlog/log/stream?format=${format}&turn=1`, { headers });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const sse = testSseReader(reader);
      const backlog = await sse.nextFrame();
      expect(backlog.event).toBe("backlog");
      expect(backlog.data).toContain("still here");
      expect((await sse.nextFrame()).event).toBe("turn-end");
    } finally {
      await reader.cancel();
    }
    // give a crash the time it used to take, then ask the process itself
    await Bun.sleep(250);
    expect(daemon.exitCode, daemonLog()).toBeNull();
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
}
