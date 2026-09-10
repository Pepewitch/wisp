import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "../src/config";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields, db } from "../src/store";
import { planBulkPurge, executeBulkPurge } from "../src/bulk-purge";
import { bulkPurgeRoute } from "../src/routes/bulk-purge";
import { retentionCommand } from "../src/cli-retention";
import { purgeTask } from "../src/task-retention";
import { parseArgs } from "../src/cli-args";

const ids: string[] = [];
const cutoff = "2001-01-01T00:00:00.000Z";
function fixture(archived = true) {
  const id = newTaskId();
  ids.push(id);
  createTask({ id, title: "Bulk fixture", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot() });
  setTaskFields(id, { archived: Number(archived) });
  db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", id]);
  const log = join(LOG_DIR, `${id}-turn1.out.log`);
  writeFileSync(log, "1234567890");
  return { id, log };
}
afterEach(async () => {
  for (const id of ids.splice(0)) if (getTask(id)) { setTaskFields(id, { archived: 1 }); await purgeTask(getTask(id)!); }
});
async function request(path: string, method = "GET", body?: unknown): Promise<any> {
  const url = new URL(path, "http://fixture");
  const response = await bulkPurgeRoute(new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }), url);
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error);
  return data;
}

test("bulk preview and CLI dry run name exact tasks/bytes and never delete", async () => {
  const archived = fixture(), live = fixture(false);
  const plan = await planBulkPurge(cutoff);
  expect(plan.tasks.map(t => t.id)).toEqual([archived.id]);
  expect(plan.bytes).toBe(10);
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await retentionCommand("purge", undefined, { "archived-before": "2001-01-01" }, request);
    expect(output.mock.calls.flat().join("\n")).toContain(`${archived.id}  10 bytes`);
    expect(output.mock.calls.flat().join("\n")).toContain("Dry run: nothing deleted");
  } finally { output.mockRestore(); }
  for (const f of [archived, live]) { expect(getTask(f.id)).not.toBeNull(); expect(existsSync(f.log)).toBe(true); }
});

test("stale count and same-count changed selection refuse without deletion", async () => {
  const first = fixture(), plan = await planBulkPurge(cutoff);
  fixture();
  await expect(executeBulkPurge(await planBulkPurge(cutoff), 1, plan.fingerprint)).rejects.toThrow(/Stale confirmation/);
  setTaskFields(first.id, { archived: 0 });
  await expect(executeBulkPurge(await planBulkPurge(cutoff), 1, plan.fingerprint)).rejects.toThrow(/changed since/);
  expect(existsSync(first.log)).toBe(true);
});

test("a task becoming live after preview is refused; other archived deletions continue", async () => {
  const live = fixture(), other = fixture();
  const plan = await planBulkPurge(cutoff);
  // Exercise the per-task guard after the outer selection check by changing a
  // row while the first purge awaits its process barrier.
  const pending = executeBulkPurge(plan, 2, plan.fingerprint);
  const last = plan.tasks[1]!.id;
  setTaskFields(last, { archived: 0 });
  const result = await pending;
  expect(result.failed.map(f => f.id)).toEqual([last]);
  expect(result.failed[0]!.error).toContain("no longer");
  expect(result.purged).toHaveLength(1);
  expect(result.reclaimedBytes).toBe(10);
  expect(existsSync(last === live.id ? live.log : other.log)).toBe(true);
});

test("confirmed batch deletes files through purgeTask and reports bytes", async () => {
  const f = fixture(), plan = await request("/api/purge?archivedBefore=2001-01-01");
  const result = await request("/api/purge", "DELETE", { cutoff: plan.cutoff, fingerprint: plan.fingerprint, confirmCount: 1 });
  expect(result).toEqual({ purged: [f.id], failed: [], reclaimedBytes: 10 });
  expect(getTask(f.id)).toBeNull();
  expect(existsSync(f.log)).toBe(false);
});

test("an unmeasurable first archive fails without preventing later deletions", async () => {
  fixture(); fixture();
  const selected = await planBulkPurge(cutoff), first = selected.tasks[0]!.id, second = selected.tasks[1]!.id;
  const link = join(LOG_DIR, `${first}-unsafe`);
  symlinkSync(join(LOG_DIR, `${first}-turn1.out.log`), link);
  try {
    const plan = await planBulkPurge(cutoff);
    const result = await executeBulkPurge(plan, 2, plan.fingerprint);
    expect(result.failed.map(f => f.id)).toEqual([first]);
    expect(result.purged).toEqual([second]);
    expect(result.reclaimedBytes).toBe(10);
    expect(getTask(first)?.purge_pending).toBe(0);
  } finally { unlinkSync(link); }
});

test("CLI refuses stale counts, ambiguous forms and malformed confirmation", async () => {
  fixture();
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(retentionCommand("purge", undefined, { "archived-before": "2001-01-01", "confirm-count": "0" }, request)).rejects.toThrow(/Stale --confirm-count/);
    for (const count of [true, "-1", "1x", "1.1"]) await expect(retentionCommand("purge", undefined, { "archived-before": "30d", "confirm-count": count }, request)).rejects.toThrow(/nonnegative integer/);
    await expect(retentionCommand("purge", "example", { "archived-before": "30d" }, request)).rejects.toThrow(/cannot be combined/);
  } finally { output.mockRestore(); }
  expect(parseArgs(["--archived-before", "30d", "--confirm-count", "2"]).flags).toEqual({ "archived-before": "30d", "confirm-count": "2" });
  for (const body of [null, [], { cutoff }, { cutoff, confirmCount: 1 }]) {
    const url = new URL("http://fixture/api/purge");
    const res = await bulkPurgeRoute(new Request(url, { method: "DELETE", body: JSON.stringify(body) }), url);
    expect(res.status).toBeGreaterThanOrEqual(400);
  }
});
