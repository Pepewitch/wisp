import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, mkdtempSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS_DIR, LOG_DIR, loadConfig } from "../src/config";
import { createTask, createTurn, finishTurn, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { exportTask, purgeTask, taskStorage } from "../src/task-retention";
import { archiveTaskWithCleanup, clearArchiveCleanup } from "../src/archive-jobs";
import { retentionRoute } from "../src/routes/retention";
import { deliverOutbox, taskDeliveryActive } from "../src/outbox";

function fixture() {
  const id = newTaskId(), repo = mkdtempSync(join(tmpdir(), "wisp-retention-repo-"));
  writeFileSync(join(repo, "source.txt"), "user repository");
  createTask({ id, title: "Retention fixture", repo_path: repo, harness: "fake", model: null, slot: freeSlot() });
  const log = join(LOG_DIR, `${id}-1.log`), assets = join(TASKS_DIR, id, "attachments", "1");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "fixture.png"), "attachment bytes");
  writeFileSync(log, "transcript bytes");
  const turn = createTurn(id, 1, "keep this conversation", null, log, null);
  finishTurn(turn, "done", 0, "kept answer");
  transition(id, "done");
  setTaskFields(id, { archived: 1, archive_assets_retained: 1 });
  return { id, repo, assets, log, task: getTask(id)! };
}

test("export is a readable snapshot; purge removes managed files/records and keeps the repository", async () => {
  const f = fixture();
  const data = await exportTask(f.task);
  const response = await retentionRoute(new Request("http://fixture/export"), f.task, "export");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(data.task.title).toBe("Retention fixture");
  expect(data.turns).toHaveLength(1);
  expect(data.files.map(x => Buffer.from(x.dataBase64, "base64").toString()).sort()).toEqual(["attachment bytes", "transcript bytes"]);
  expect((await taskStorage(f.task)).files).toBe(2);
  await purgeTask(f.task);
  expect(getTask(f.id)).toBeNull();
  expect(existsSync(f.log)).toBe(false);
  expect(existsSync(join(TASKS_DIR, f.id))).toBe(false);
  expect(readFileSync(join(f.repo, "source.txt"), "utf8")).toBe("user repository");
});

test("active tasks and incomplete archive jobs cannot be deleted; explicit confirmation is required", async () => {
  const f = fixture();
  setTaskFields(f.id, { archived: 0 });
  await expect(purgeTask(f.task)).rejects.toThrow(/Archive this task/);
  archiveTaskWithCleanup(f.id, null, { task_id: f.id, stage: "stop-turn", force: false, stop_turn: false, removable: false, repo_path: f.repo, worktree_path: f.repo, branch: null, archive_script: null, timeout_minutes: 1 });
  await expect(purgeTask(getTask(f.id)!)).rejects.toThrow(/cleanup is incomplete/);
  clearArchiveCleanup(f.id);
  const req = new Request("http://fixture/purge", { method: "DELETE", body: JSON.stringify({ confirmTaskId: "wrong" }) });
  expect((await retentionRoute(req, getTask(f.id)!, "purge")).status).toBe(400);
  expect(existsSync(f.log)).toBe(true);
  await purgeTask(getTask(f.id)!);
});

test("failed deletion keeps a durable retry record and refuses export of partial data", async () => {
  const f = fixture(), link = join(f.assets, "unsafe-link");
  symlinkSync(join(f.repo, "source.txt"), link);
  await expect(exportTask(f.task)).rejects.toThrow(/symbolic link/);
  await expect(purgeTask(f.task)).rejects.toThrow(/symbolic link/);
  expect(getTask(f.id)!.purge_pending).toBe(1);
  expect(existsSync(f.log)).toBe(true);
  await expect(exportTask(f.task)).rejects.toThrow(/deletion was started/);
  unlinkSync(link);
  await purgeTask(getTask(f.id)!);
  expect(getTask(f.id)).toBeNull();
  expect(existsSync(join(f.repo, "source.txt"))).toBe(true);
});

test("an in-flight webhook holds deletion; deletion-pending tasks never send new deliveries", async () => {
  const f = fixture();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => { const payload = await req.json() as { task_id: string }; if (payload.task_id === f.id) { hits++; await ready; } return new Response("ok"); } });
  const delivery = deliverOutbox({ ...loadConfig(), webhooks: [`http://127.0.0.1:${server.port}`] });
  try {
    for (const deadline = Date.now() + 3000; !taskDeliveryActive(f.id);) { if (Date.now() > deadline) throw new Error("delivery did not start"); await Bun.sleep(5); }
    await expect(purgeTask(f.task)).rejects.toThrow(/webhook delivery/);
  } finally { finish(); await delivery; }
  expect(hits).toBeGreaterThan(0);
  try {
    transition(f.id, "done", "new pending delivery");
    setTaskFields(f.id, { purge_pending: 1 });
    const before = hits;
    await deliverOutbox({ ...loadConfig(), webhooks: [`http://127.0.0.1:${server.port}`] });
    expect(hits).toBe(before);
    await purgeTask(getTask(f.id)!);
  } finally { server.stop(true); }
});


test("a retry after files were partly removed completes deletion", async () => {
  const f = fixture();
  setTaskFields(f.id, { purge_pending: 1 });
  rmSync(f.log);
  await purgeTask(getTask(f.id)!);
  expect(getTask(f.id)).toBeNull();
  expect(existsSync(f.assets)).toBe(false);
  expect(existsSync(join(f.repo, "source.txt"))).toBe(true);
});

test("oversized exports refuse with backup guidance before allocating file bytes", async () => {
  const f = fixture();
  truncateSync(f.log, 33 * 1024 * 1024);
  await expect(exportTask(f.task)).rejects.toThrow(/32 MiB.*offline backup/);
  expect(getTask(f.id)!.purge_pending).toBe(0);
  await purgeTask(f.task);
});
