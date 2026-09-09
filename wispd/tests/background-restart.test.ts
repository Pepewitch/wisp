import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTask } from "../src/types";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("background fixture timed out");
    await Bun.sleep(50);
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a finished turn's watcher survives steering and daemon restart, then Stop preserves the completed result", async () => {
  const home = mkdtempSync(join(tmpdir(), "wisp-background-restart-"));
  const ready = join(home, "ready.json");
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let descendant: number | undefined;
  let group: number | undefined;
  let port = 0;
  async function launch(mode: "seed" | "resume") {
    rmSync(ready, { force: true });
    daemon = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, "fixtures/background-daemon.ts"), mode],
      env: { ...process.env, WISP_HOME: home }, stdout: "ignore", stderr: Bun.file(join(home, `${mode}.log`)),
    });
    await until(() => existsSync(ready));
    port = JSON.parse(readFileSync(ready, "utf8")).port as number;
  }
  const request = (suffix = "", body?: unknown) => fetch(`http://127.0.0.1:${port}/api/tasks/tbgfixture${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer background-fixture-token", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const task = async () => (await (await request()).json()) as ApiTask & { turns: { pid: number; result: string }[] };
  try {
    await launch("seed");
    await until(async () => { const value = await task(); return value.state === "done" && value.background?.state === "running"; });
    descendant = Number(readFileSync(join(home, "fixture-workspace/child.pid"), "utf8"));
    group = (await task()).turns[0]!.pid;
    expect(alive(descendant)).toBe(true);
    expect((await request("/send", { message: "do another turn" })).status).toBe(200);
    await until(async () => { const value = await task(); return value.turn_count === 2 && value.state === "done"; });
    expect(alive(descendant)).toBe(true);
    expect((await task()).background?.state).toBe("running");
    daemon!.kill("SIGKILL");
    await daemon!.exited;
    await launch("resume");
    expect((await task()).background).toEqual({ state: "running", groups: 1 });
    const refusal = await request("/archive", {});
    expect(refusal.status).toBe(409);
    expect((await task()).archived).toBe(false);
    expect(existsSync(join(home, "fixture-workspace/child.pid"))).toBe(true);
    const results = (await task()).turns.map(turn => turn.result);
    expect((await request("/interrupt", {})).status).toBe(200);
    await until(() => !alive(descendant!));
    const stopped = await task();
    expect(stopped.state).toBe("done");
    expect(stopped.background).toEqual({ state: "none", groups: 0 });
    expect(stopped.turns.map(turn => turn.result)).toEqual(results);
  } finally {
    if (daemon?.exitCode === null) { daemon.kill("SIGKILL"); await daemon.exited; }
    if (descendant && alive(descendant) && group) {
      try { process.kill(-group, "SIGKILL"); } catch { /* fixture already exited */ }
    }
  }
}, 45_000);
