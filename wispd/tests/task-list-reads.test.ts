import { describe, expect, test } from "bun:test";
import type { ApiTaskListItem, ConversationDetail } from "../../shared/api/task";
import { archiveTaskWithCleanup, failArchiveCleanup } from "../src/archive-jobs";
import { cleanupSummary } from "../src/archive-progress";
import { autopilotStatus, autopilotStatuses, setAutopilot } from "../src/autopilot/store";
import { type WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { createTask, createTurn, db, finishTurn, freeSlot, newTaskId, setTaskFields, transition } from "../src/store";
import { backgroundWork, BACKGROUND_SETTLE_MS } from "../src/task-processes";
import { testRouteContext } from "./helpers/daemon-context";

/**
 * What a task list and a task's turns serve, and what reading them costs:
 * internal columns stay home, and the archived list's per-row reads are made
 * once for the whole list.
 */

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "task-list-reads-token",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

async function get<T>(path: string): Promise<T> {
  const url = new URL(`http://wisp.test${path}`);
  return (await (await route(new Request(url), url, url.pathname, testRouteContext(cfg, {}))).json()) as T;
}

function makeTask(title = "list reads") {
  const task = createTask({ id: newTaskId(), title, repo_path: "/tmp/repo", harness: "claude", model: null, slot: freeSlot() });
  setTaskFields(task.id, { worktree_path: "/tmp/repo-worktree", branch: `wisp/${task.id}`, base_commit: "0".repeat(40) });
  return task;
}

function archive(id: string, failure?: string): void {
  archiveTaskWithCleanup(id, null, {
    task_id: id, stage: "remove-worktree", force: false, stop_turn: false, removable: true,
    repo_path: "/tmp/repo", worktree_path: "/tmp/repo-worktree", branch: null, archive_script: null, timeout_minutes: 1,
  });
  if (failure) failArchiveCleanup(id, failure);
}

/** How many statements `fn` prepares: the per-row reads a list used to make show up here. */
async function statements(fn: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const query = db.query;
  db.query = ((sql: string) => {
    count++;
    return query.call(db, sql);
  }) as typeof db.query;
  try {
    await fn();
  } finally {
    db.query = query;
  }
  return count;
}

const INTERNAL = ["skills_json", "custom_title", "input_seq", "archive_assets_retained", "purge_pending"];

describe("what a task serves", () => {
  test("list rows and the conversation detail leave the internal columns out, and keep what clients read", async () => {
    const task = makeTask();
    setTaskFields(task.id, { skills_json: JSON.stringify(Array.from({ length: 50 }, (_, i) => `skill-${i}`)), custom_title: 1, session_id: "session-1" });

    const row = (await get<ApiTaskListItem[]>("/api/tasks")).find((t) => t.id === task.id)!;
    const detail = await get<ConversationDetail>(`/api/tasks/${task.id}/conversation`);
    for (const served of [row, detail]) {
      for (const key of INTERNAL) expect(served).not.toHaveProperty(key);
      expect(served).toMatchObject({ id: task.id, session_id: "session-1", verify_role: null, attachmentsRetained: true, deletionPending: false, archived: false, fast: false });
    }
  });

  test("an API turn carries neither the outcome checkpoint nor the daemon's log path", async () => {
    const task = makeTask();
    finishTurn(createTurn(task.id, 1, "go", null, "/daemon/only/turn-1.out.log"), "done", 0, "ok");
    const detail = await get<ConversationDetail>(`/api/tasks/${task.id}/conversation`);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0]).not.toHaveProperty("log_file");
    expect(detail.turns[0]).not.toHaveProperty("outcome_json");
    expect(detail.turns[0]).toMatchObject({ n: 1, prompt: "go", result: "ok", status: "done" });
  });
});

describe("the archived list's reads", () => {
  test("cleanup and background work read once for the list, and say what the per-task reads say", async () => {
    const running = makeTask("archive in progress");
    transition(running.id, "done", "wrapped");
    archive(running.id, "the archive script failed");
    const finished = makeTask("archive complete");
    archive(finished.id);
    db.run("DELETE FROM archive_cleanups WHERE task_id = ?", [finished.id]);
    const busy = makeTask("background work");
    const turnId = createTurn(busy.id, 1, "go", null, "/tmp/busy.log");
    finishTurn(turnId, "done", 0, "ok");
    // past the settle window, so the badge reports it
    db.run("UPDATE turns SET ended_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), turnId]);
    db.run(`INSERT INTO turn_process_groups (turn_id, task_id, pgid, members_json, state, stop_requested)
      VALUES (?, ?, 999998, '[{"pid":999998,"started":null}]', 'running', 0)`, [turnId, busy.id]);

    try {
      const rows = await get<ApiTaskListItem[]>("/api/tasks?archived=1");
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(running.id)!.cleanup).toEqual(cleanupSummary(running.id));
      expect(byId.get(running.id)!.cleanup).toMatchObject({ state: "pending", error: "the archive script failed" });
      expect(byId.get(finished.id)!.cleanup).toEqual(cleanupSummary(finished.id));
      expect(byId.get(finished.id)!.cleanup).toMatchObject({ state: "complete" });
      expect(byId.get(busy.id)!.background).toEqual(backgroundWork(busy.id, BACKGROUND_SETTLE_MS));
      expect(byId.get(busy.id)!.background).toMatchObject({ state: "running", groups: 1 });
    } finally {
      db.run("UPDATE turn_process_groups SET state = 'none' WHERE turn_id = ?", [turnId]);
    }
  });

  test("statements stay the same however many archived tasks the list holds", async () => {
    const before = await statements(() => get("/api/tasks?archived=1"));
    for (let i = 0; i < 10; i++) {
      const task = makeTask(`archived ${i}`);
      archive(task.id);
    }
    expect(await statements(() => get("/api/tasks?archived=1"))).toBe(before);
  });
});

describe("autopilotStatuses", () => {
  test("answers only the tasks it is asked about, each with its latest row", () => {
    const asked = makeTask("asked");
    const other = makeTask("not asked");
    setAutopilot(asked.id, { autoFix: true });
    setAutopilot(asked.id, { autoFix: false });
    setAutopilot(asked.id, { autoMerge: true });
    setAutopilot(other.id, { autoFix: true });

    const statuses = autopilotStatuses([asked.id, "tnope9"]);
    expect([...statuses.keys()]).toEqual([asked.id]);
    expect(statuses.get(asked.id)).toEqual(autopilotStatus(asked.id));
    expect(statuses.get(asked.id)).toMatchObject({ autoMerge: true, autoFix: false });
  });
});
