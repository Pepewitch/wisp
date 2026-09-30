import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { autopilotRow, pauseAutopilot } from "../src/autopilot/store";
import { cliClientHeaders } from "../src/cli-api";
import { auditCommand, formatAudit } from "../src/cli-audit";
import { offlineAnswer } from "../src/cli-help";
import type { WispConfig } from "../src/config";
import { route } from "../src/routes";
import { hasRunningTurn, startTurn } from "../src/runner";
import { createTask, createTaskMessage, db, freeSlot, getTask, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";
import { AUDIT_KEEP, recordAudit, recordSendAudit, requestActor, taskAudit } from "../src/task-audit";
import type { TaskMode } from "../src/types";
import type { TaskAuditEntry } from "../../shared/task-audit";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};

const quick: AdapterDef = { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null };
const slow: AdapterDef = { bin: "bash", exec: ["-c", "sleep 30"], parse: { format: "text" }, attach: null };
const adapters = { quick, slow };

const WEB = { "x-wisp-client": "web" };

function call(path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const url = new URL(`http://wisp.test${path}`);
  return Promise.resolve(route(
    new Request(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    url,
    url.pathname,
    cfg,
    adapters,
  ));
}

function idleTask(options: { harness?: string; mode?: TaskMode; branch?: string } = {}): string {
  const task = createTask({
    id: newTaskId(),
    title: "audit test",
    repo_path: "/tmp/audit-repo",
    harness: options.harness ?? "quick",
    model: null,
    mode: options.mode,
    slot: freeSlot(),
  });
  setTaskFields(task.id, {
    worktree_path: mkdtempSync(join(tmpdir(), "wisp-audit-")),
    branch: options.branch ?? `wisp/${task.id}`,
  });
  transition(task.id, "done", "setup done");
  return task.id;
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(25);
  }
}

const settled = (id: string) => () => hasRunningTurn(id) === null && turnsFor(id).every((turn) => turn.status !== "running");
const recorded = (id: string, action: string) => taskAudit(id, 500).filter((entry) => entry.action === action);

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=Audit Test", "-c", "user.email=audit@example.invalid", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

describe("which actor a request reports", () => {
  const actor = (headers: Record<string, string>) => requestActor(new Request("http://wisp.test/", { headers }));

  test("each client's header names it; anything else is api", () => {
    expect(actor({ "x-wisp-client": "web" })).toBe("web");
    expect(actor({ "x-wisp-client": "Desktop" })).toBe("desktop");
    expect(actor({ "x-wisp-client": "cli" })).toBe("cli");
    expect(actor({})).toBe("api");
    expect(actor({ "x-wisp-client": "autopilot" })).toBe("api");
    expect(actor({ "x-wisp-client": "agent:abcde" })).toBe("api");
  });

  test("the CLI inside a task reads as that task's agent; only the CLI can say so", () => {
    expect(actor(cliClientHeaders({ WISP_TASK_ID: "abcde" }))).toBe("agent:abcde");
    expect(actor(cliClientHeaders({}))).toBe("cli");
    expect(actor({ "x-wisp-client": "cli", "x-wisp-task": "not a task id" })).toBe("cli");
    expect(actor({ "x-wisp-client": "web", "x-wisp-task": "abcde" })).toBe("web");
  });
});

describe("each covered action writes one audit row", () => {
  test("create, from a CLI running inside another task", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-audit-repo-"));
    await git(repo, "init", "-q");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const res = await call("/api/tasks", "POST", cliClientHeaders({ WISP_TASK_ID: "orch1" }), {
      repoPath: repo, prompt: "do it", harness: "quick", mode: "local",
    });
    expect(res.status).toBe(201);
    const { id } = await res.json() as { id: string };
    await until(() => getTask(id)!.state !== "creating" && settled(id)());
    expect(recorded(id, "create")).toEqual([expect.objectContaining({ actor: "agent:orch1", detail: "quick, local" })]);
  });

  test("send, once per message however often a client retries it", async () => {
    const id = idleTask();
    const send = () => call(`/api/tasks/${id}/send`, "POST", WEB, { message: "hello", clientMessageId: `audit-retry-${id}` });
    expect((await send()).status).toBe(200);
    await until(settled(id));
    expect((await send()).status).toBe(200);
    const sends = recorded(id, "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ actor: "web", detail: expect.stringMatching(/^message \S+$/) });
  });

  test("a steered send is recorded as a steer, and an interrupting one says so", () => {
    const id = idleTask();
    const message = createTaskMessage({ id: `m${newTaskId()}`, taskId: id, text: "x", attachmentHash: "" }, false);
    recordSendAudit(id, { disposition: "steered", message, interrupted: true }, "desktop");
    recordSendAudit(id, { disposition: "steered", message }, "desktop");
    expect(recorded(id, "steer")).toEqual([
      expect.objectContaining({ actor: "desktop", detail: `message ${message.id} · interrupted the running turn` }),
    ]);
  });

  test("send-now of a queued message", async () => {
    const id = idleTask();
    const message = createTaskMessage({ id: `m${newTaskId()}`, taskId: id, text: "queued", attachmentHash: "" }, false);
    expect((await call(`/api/tasks/${id}/messages/${message.id}/send-now`, "POST", WEB, {})).status).toBe(200);
    await until(settled(id));
    expect(recorded(id, "send-now")).toEqual([expect.objectContaining({ actor: "web", detail: `message ${message.id}` })]);
  });

  test("interrupt", async () => {
    const id = idleTask({ harness: "slow" });
    startTurn(getTask(id)!, "wait", slow, cfg);
    await until(() => hasRunningTurn(id) !== null);
    expect((await call(`/api/tasks/${id}/interrupt`, "POST", { "x-wisp-client": "desktop" }, {})).status).toBe(200);
    await until(settled(id));
    expect(recorded(id, "interrupt")).toEqual([expect.objectContaining({ actor: "desktop" })]);
  });

  test("fresh-session", async () => {
    const id = idleTask();
    expect((await call(`/api/tasks/${id}/fresh-session`, "POST", {}, {})).status).toBe(200);
    expect(recorded(id, "fresh-session")).toEqual([expect.objectContaining({ actor: "api" })]);
  });

  test("push", async () => {
    const remote = mkdtempSync(join(tmpdir(), "wisp-audit-remote-"));
    await git(remote, "init", "-q", "--bare");
    const id = idleTask({ branch: "audit-branch" });
    const worktree = getTask(id)!.worktree_path!;
    await git(worktree, "init", "-q", "-b", "audit-branch");
    await git(worktree, "commit", "-q", "--allow-empty", "-m", "work");
    await git(worktree, "remote", "add", "origin", remote);
    expect((await call(`/api/tasks/${id}/push`, "POST", cliClientHeaders({}), {})).status).toBe(200);
    expect(recorded(id, "push")).toEqual([expect.objectContaining({ actor: "cli", detail: "audit-branch" })]);
  });

  test("archive and force-archive", async () => {
    const plain = idleTask({ mode: "local" });
    const forced = idleTask({ mode: "local" });
    expect((await call(`/api/tasks/${plain}/archive`, "POST", WEB, {})).status).toBe(200);
    expect((await call(`/api/tasks/${forced}/archive`, "POST", cliClientHeaders({ WISP_TASK_ID: "orch2" }), { force: true })).status).toBe(200);
    expect(recorded(plain, "archive")).toEqual([expect.objectContaining({ actor: "web" })]);
    expect(recorded(forced, "force-archive")).toEqual([expect.objectContaining({ actor: "agent:orch2" })]);
  });

  test("autopilot on and off, only when a switch moves, and resume", async () => {
    const id = idleTask();
    const agent = cliClientHeaders({ WISP_TASK_ID: "orch3" });
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", agent, { autoMerge: true })).status).toBe(200);
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", agent, { autoMerge: true })).status).toBe(200);
    pauseAutopilot(autopilotRow(id)!, "Held for the test", new Date());
    expect((await call(`/api/tasks/${id}/autopilot/resume`, "POST", WEB, {})).status).toBe(200);
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", WEB, { autoMerge: false })).status).toBe(200);
    expect(recorded(id, "autopilot").map(({ actor, detail }) => [actor, detail])).toEqual([
      ["web", "auto-merge off"],
      ["agent:orch3", "auto-merge on"],
    ]);
    expect(recorded(id, "autopilot-resume")).toEqual([expect.objectContaining({ actor: "web" })]);
  });

  test("workflow start, update, pause, resume and complete; its messages read as the workflow's", async () => {
    const id = idleTask();
    const created = await call(`/api/tasks/${id}/workflows`, "POST", WEB, { type: "heartbeat", params: { prompt: "Check" } });
    expect(created.status).toBe(201);
    const workflow = await created.json() as { id: string; revision: number };
    expect((await call(`/api/workflows/${workflow.id}`, "PATCH", WEB, { revision: workflow.revision, params: { everyMinutes: 10 } })).status).toBe(200);
    for (const verb of ["pause", "resume", "complete"]) {
      expect((await call(`/api/workflows/${workflow.id}/${verb}`, "POST", WEB, {})).status).toBe(200);
    }
    const about = `${workflow.id} (heartbeat)`;
    for (const action of ["workflow-start", "workflow-update", "workflow-pause", "workflow-resume", "workflow-complete"]) {
      expect(recorded(id, action)).toEqual([expect.objectContaining({ actor: "web", detail: about })]);
    }
    const message = createTaskMessage({ id: `m${newTaskId()}`, taskId: id, text: "wake", attachmentHash: "", origin: "workflow" }, false);
    db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [workflow.id, message.id]);
    expect(recorded(id, "send")).toEqual([
      expect.objectContaining({ actor: `workflow:${workflow.id}`, detail: `message ${message.id}` }),
    ]);
  });
});

describe("reading it", () => {
  test("the route is newest first and bounded, and refuses a bad limit", async () => {
    const id = idleTask();
    recordAudit(id, "push", "cli", null, new Date("2026-01-01T00:00:00.000Z"));
    recordAudit(id, "interrupt", "web", null, new Date("2026-01-02T00:00:00.000Z"));
    recordAudit(id, "archive", "desktop", null, new Date("2026-01-03T00:00:00.000Z"));
    const res = await call(`/api/tasks/${id}/audit?limit=2`, "GET", WEB);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { entries } = await res.json() as { entries: TaskAuditEntry[] };
    expect(entries.map((entry) => entry.action)).toEqual(["archive", "interrupt"]);
    for (const limit of ["0", "501", "abc", "1.5"]) {
      expect((await call(`/api/tasks/${id}/audit?limit=${limit}`, "GET", WEB)).status).toBe(400);
    }
    expect((await call("/api/tasks/tnope7/audit", "GET", WEB)).status).toBe(404);
  });

  test("each task keeps only its newest entries", () => {
    const id = idleTask();
    const insert = db.query("INSERT INTO task_audit (task_id, at, action, actor, detail) VALUES (?, ?, 'push', 'cli', ?)");
    db.transaction(() => { for (let n = 0; n < AUDIT_KEEP; n++) insert.run(id, "2026-01-01T00:00:00.000Z", `old ${n}`); })();
    recordAudit(id, "archive", "web");
    const count = db.query("SELECT COUNT(*) AS n, MIN(detail) AS oldest FROM task_audit WHERE task_id = ?").get(id) as { n: number };
    expect(count.n).toBe(AUDIT_KEEP);
    expect(db.query("SELECT 1 FROM task_audit WHERE task_id = ? AND detail = 'old 0'").get(id)).toBeNull();
    expect(taskAudit(id, 1)[0]).toMatchObject({ action: "archive", actor: "web" });
  });

  test("wisp audit prints one line per entry and asks the audit route", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await auditCommand(["tabcde"], { limit: "5" }, async (path) => {
        calls.push(path);
        return { entries: [{ at: "2026-01-03T00:00:00.123Z", action: "archive", actor: "agent:orch1", detail: null }] };
      });
    } finally {
      console.log = log;
    }
    expect(calls).toEqual(["/api/tasks/tabcde/audit?limit=5"]);
    expect(lines.join("\n")).toBe(formatAudit([{ at: "2026-01-03T00:00:00.123Z", action: "archive", actor: "agent:orch1", detail: null }]));
    expect(lines.join("\n")).toMatch(/^2026-01-03T00:00:00Z {2}archive {13}agent:orch1$/);
    expect(offlineAnswer(["audit", "tabcde", "--help"])).toMatchObject({ exit: 0, text: expect.stringContaining("audit <task>") });
  });
});
