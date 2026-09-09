import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CleanupSummary } from "../src/archive-progress";

const driver = join(import.meta.dir, "fixtures/archive-daemon.ts");
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await Bun.sleep(20); }
}
function seed(count: number): string {
  const home = mkdtempSync(join(tmpdir(), "wisp-archive-restart-"));
  const result = Bun.spawnSync([process.execPath, driver, "seed", String(count)], { env: { ...process.env, WISP_HOME: home }, timeout: 15000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return home;
}
async function start(home: string) {
  rmSync(join(home, "ready.json"), { force: true });
  const child = Bun.spawn([process.execPath, driver, "serve"], { env: { ...process.env, WISP_HOME: home }, stdout: "ignore", stderr: "pipe" });
  try {
    await until("daemon readiness without waiting for hooks", () => existsSync(join(home, "ready.json")), 4000);
    const port = JSON.parse(readFileSync(join(home, "ready.json"), "utf8")).port;
    return { child, base: `http://127.0.0.1:${port}` };
  } catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
}
function request(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer archive-fixture-token", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}
function release(home: string, count: number) {
  for (let i = 1; i <= count; i++) writeFileSync(join(home, `tfixture${i}-release`), "release");
}

test("slow pending hooks do not block startup; two workers keep the remaining queue bounded", async () => {
  const home = seed(3), daemon = await start(home);
  try {
    expect((await request(daemon.base, "/api/health")).status).toBe(200);
    await until("two running hooks", () => existsSync(join(home, "tfixture1-effects")) && existsSync(join(home, "tfixture2-effects")));
    expect(existsSync(join(home, "tfixture3-effects"))).toBe(false);
    const tasks = await (await request(daemon.base, "/api/tasks?cleanup=1")).json();
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t: { archived: boolean; cleanup: CleanupSummary }) => t.archived && t.cleanup.state !== "complete")).toBe(true);
    writeFileSync(join(home, "tfixture1-release"), "release");
    await until("a free worker takes the next job while another hook is still running", () => existsSync(join(home, "tfixture3-effects")));
    expect(existsSync(join(home, "tfixture2-release"))).toBe(false);
    release(home, 3);
    await until("all jobs complete", async () => (await (await request(daemon.base, "/api/tasks?cleanup=1")).json()).length === 0);
  } finally { release(home, 3); await Bun.sleep(200); daemon.child.kill("SIGTERM"); await daemon.child.exited; }
}, 20000);

test("a crash after a hook effect pauses recovery and blocks decisions until that process group ends", async () => {
  const home = seed(1);
  let daemon = await start(home);
  try {
    await until("external hook effect", () => existsSync(join(home, "tfixture1-effects")));
    daemon.child.kill("SIGKILL"); await daemon.child.exited;
    daemon = await start(home);
    const endpoint = "/api/tasks/tfixture1/cleanup";
    const cleanup = await (await request(daemon.base, endpoint)).json() as CleanupSummary;
    expect(cleanup.state).toBe("needs-attention");
    expect(cleanup.uncertain).toBe(true);
    for (const action of ["confirm", "rerun"]) {
      const response = await request(daemon.base, endpoint, { action, revision: cleanup.revision });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("process group");
    }
    expect(readFileSync(join(home, "tfixture1-effects"), "utf8")).toBe("effect\n");
    release(home, 1);
    await until("explicit confirmation after the old group exits", async () => (await request(daemon.base, endpoint, { action: "confirm", revision: cleanup.revision })).status === 202);
    await until("cleanup complete", async () => (await (await request(daemon.base, endpoint)).json()).state === "complete");
    expect(readFileSync(join(home, "tfixture1-effects"), "utf8")).toBe("effect\n");
  } finally { release(home, 1); await Bun.sleep(200); if (daemon.child.exitCode === null) { daemon.child.kill("SIGTERM"); await daemon.child.exited; } }
}, 20000);
