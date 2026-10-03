import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { samplePng } from "../scripts/harness/image-output-probe";
import { loadConfig, LOG_DIR } from "../src/config";
import { outputRoute } from "../src/routes/outputs";
import { createTask, createTurn, freeSlot, newTaskId } from "../src/store";

test("CLI add, list and save roundtrip actual task-owned bytes without overwriting local files", async () => {
  const task = createTask({ id: newTaskId(), title: "CLI outputs", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  createTurn(task.id, 1, "Show an image", null, join(LOG_DIR, `${task.id}-1.log`), null);
  const requests: { path: string; client: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.headers.get("authorization") !== "Bearer synthetic-output-token") return new Response("unauthorized", { status: 401 });
    const url = new URL(req.url);
    requests.push({ path: url.pathname, client: req.headers.get("x-wisp-client") });
    return await outputRoute(req, url, url.pathname, req.method) ?? new Response("missing", { status: 404 });
  } });
  const scratch = mkdtempSync(join(tmpdir(), "wisp-cli-images-")), home = join(scratch, "home");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...loadConfig(), host: "127.0.0.1", port: server.port, token: "synthetic-output-token" }));
  const source = join(scratch, "plot.png"), destination = join(scratch, "saved.png");
  writeFileSync(source, samplePng());
  const run = async (args: string[]) => {
    const { NODE_ENV: _node, WISP_COMMAND_NAME: _name, WISP_BRIEF_RUN: _brief, ...inherited } = process.env;
    const child = Bun.spawn({ cmd: [process.execPath, "src/index.ts", ...args], cwd: resolve(import.meta.dir, ".."), env: { ...inherited, WISP_HOME: home, WISP_TASK_ID: task.id }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, exit };
  };
  try {
    const added = await run(["output", "add", source, "--turn", "1", "--json"]);
    expect(added.exit).toBe(0);
    const image = JSON.parse(added.out).image as { id: string };
    const listed = await run(["output", "list", task.id, "--turn", "1"]);
    expect(listed.exit).toBe(0);
    expect(listed.out).toContain(`wisp output save ${task.id} ${image.id} --turn 1 --out <new-file>`);
    expect(listed.out).toContain("plot.png");
    expect((await run(["output", "save", task.id, image.id, "--turn", "1", "--out", destination])).exit).toBe(0);
    expect(readFileSync(destination)).toEqual(samplePng());
    writeFileSync(destination, "keep local changes");
    expect((await run(["output", "save", task.id, image.id, "--turn", "1", "--out", destination])).exit).toBe(1);
    expect(readFileSync(destination, "utf8")).toBe("keep local changes");
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.client === "cli")).toBe(true);
    const invalid = await run(["output", "add", source, "--turn", "-1"]);
    expect(invalid.exit).toBe(1);
    expect(requests).toHaveLength(4);
  } finally { await server.stop(true); }
});
