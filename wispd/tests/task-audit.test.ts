import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { archiveTaskWithCleanup } from "../src/archive-jobs";
import { updateProgress } from "../src/archive-progress";
import { autopilotRow, pauseAutopilot } from "../src/autopilot/store";
import { cliClientHeaders } from "../src/cli-api";
import { auditCommand, formatAudit } from "../src/cli-audit";
import { offlineAnswer } from "../src/cli-help";
import type { WispConfig } from "../src/config";
import { route } from "../src/routes";
import { webTerminalEnv } from "../src/terminal";
import { envForCwd, taskEnv } from "../src/turn-input";
import { hasRunningTurn, startTurn } from "../src/runner";
import { createTask, createTaskMessage, db, freeSlot, getTask, newTaskId, setTaskFields, transition, turnsFor } from "../src/store";
import { AUDIT_KEEP, recordAudit, recordSendAudit, requestActor, taskAudit } from "../src/task-audit";
import type { TaskMode } from "../src/types";
import type { TaskAuditEntry } from "../../shared/api/task-audit";

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
/** What the CLI sends from inside a harness turn of task `id`. */
const agentHeaders = (id: string) => cliClientHeaders({ WISP_AGENT_TURN: "1", WISP_TASK_ID: id });

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
    expect(actor(agentHeaders("abcde"))).toBe("agent:abcde");
    expect(actor(cliClientHeaders({}))).toBe("cli");
    // a task's terminal carries WISP_TASK_ID too, but no turn marker: a person typing there
    expect(actor(cliClientHeaders({ WISP_TASK_ID: "abcde" }))).toBe("cli");
    expect(actor({ "x-wisp-client": "cli", "x-wisp-task": "not a task id" })).toBe("cli");
    expect(actor({ "x-wisp-client": "web", "x-wisp-task": "abcde" })).toBe("web");
  });
});

describe("where the CLI runs decides whether it is an agent", () => {
  test("a harness turn carries the marker; a task terminal never does, even from a daemon started inside a turn", async () => {
    const probe: AdapterDef = { bin: "bash", exec: ["-c", 'printf "%s|%s" "$WISP_AGENT_TURN" "$WISP_TASK_ID"'], parse: { format: "text" }, attach: null };
    const id = idleTask();
    startTurn(getTask(id)!, "env", probe, cfg);
    await until(() => turnsFor(id)[0]?.status === "done");
    expect(turnsFor(id)[0]!.result).toBe(`1|${id}`);

    const task = getTask(id)!;
    const terminal = envForCwd(webTerminalEnv({ ...process.env, WISP_AGENT_TURN: "1" }, taskEnv(task)), task.worktree_path!);
    expect(terminal.WISP_TASK_ID).toBe(id);
    expect(terminal.WISP_AGENT_TURN).toBeUndefined();
    expect(requestActor(new Request("http://wisp.test/", { headers: cliClientHeaders(terminal) }))).toBe("cli");
  });
});

describe("each covered action writes one audit row", () => {
  test("create, from a CLI running inside another task", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wisp-audit-repo-"));
    await git(repo, "init", "-q");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const res = await call("/api/tasks", "POST", agentHeaders("orch1"), {
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
    expect((await call(`/api/tasks/${forced}/archive`, "POST", agentHeaders("orch2"), { force: true })).status).toBe(200);
    expect(recorded(plain, "archive")).toEqual([expect.objectContaining({ actor: "web" })]);
    expect(recorded(forced, "force-archive")).toEqual([expect.objectContaining({ actor: "agent:orch2" })]);
  });

  test("autopilot on and off, only when a switch moves, and resume", async () => {
    const id = idleTask();
    const agent = agentHeaders("orch3");
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", agent, { autoMerge: true })).status).toBe(200);
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", agent, { autoMerge: true })).status).toBe(200);
    expect((await call(`/api/tasks/${id}/autopilot/resume`, "POST", WEB, {})).status).toBe(200);
    expect(recorded(id, "autopilot-resume")).toEqual([]);
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

  test("editing and cancelling a queued message; cancelling a workflow's message pauses it for whoever asked", async () => {
    const id = idleTask();
    const mine = createTaskMessage({ id: `m${newTaskId()}`, taskId: id, text: "later", attachmentHash: "" }, false);
    expect((await call(`/api/tasks/${id}/messages/${mine.id}`, "PATCH", WEB, { message: "sooner" })).status).toBe(200);
    expect((await call(`/api/tasks/${id}/messages/${mine.id}`, "DELETE", agentHeaders("orch4"))).status).toBe(200);
    expect(recorded(id, "edit")).toEqual([expect.objectContaining({ actor: "web", detail: `message ${mine.id}` })]);

    const created = await call(`/api/tasks/${id}/workflows`, "POST", WEB, { type: "heartbeat", params: { prompt: "Check" } });
    const workflow = await created.json() as { id: string };
    const generated = createTaskMessage({ id: `m${newTaskId()}`, taskId: id, text: "wake", attachmentHash: "", origin: "workflow" }, false);
    db.run("UPDATE task_messages SET workflow_id = ? WHERE id = ?", [workflow.id, generated.id]);
    expect((await call(`/api/tasks/${id}/messages/${generated.id}`, "DELETE", { "x-wisp-client": "desktop" })).status).toBe(200);

    expect(recorded(id, "cancel").map(({ actor, detail }) => [actor, detail])).toEqual([
      ["desktop", `message ${generated.id}`],
      ["agent:orch4", `message ${mine.id}`],
    ]);
    expect(recorded(id, "workflow-pause")).toEqual([
      expect.objectContaining({ actor: "desktop", detail: `${workflow.id} (heartbeat) · its message ${generated.id} was cancelled` }),
    ]);
    // it never reached the agent, so it is not a send
    expect(recorded(id, "send")).toEqual([]);
  });

  test("rename", async () => {
    const id = idleTask();
    expect((await call(`/api/tasks/${id}`, "PATCH", WEB, { title: "A clearer name" })).status).toBe(200);
    expect(recorded(id, "rename")).toEqual([expect.objectContaining({ actor: "web", detail: "A clearer name" })]);
  });

  test("resolving an archive cleanup", async () => {
    const id = idleTask({ mode: "local" });
    const task = getTask(id)!;
    archiveTaskWithCleanup(id, null, {
      task_id: id, stage: "stop-turn", force: false, stop_turn: false, removable: false, repo_path: task.repo_path,
      worktree_path: task.worktree_path, branch: task.branch, archive_script: null, timeout_minutes: 1,
    });
    updateProgress(id, { phase: "remove-worktree", status: "needs-attention" }, false);
    const { revision } = db.query("SELECT revision FROM archive_cleanup_progress WHERE task_id = ?").get(id) as { revision: number };
    expect((await call(`/api/tasks/${id}/cleanup`, "POST", WEB, { action: "retry", revision })).status).toBe(202);
    expect(recorded(id, "cleanup")).toEqual([expect.objectContaining({ actor: "web", detail: "retry at remove-worktree" })]);
    await until(() => db.query("SELECT 1 FROM archive_cleanups WHERE task_id = ?").get(id) === null);
  });

  test("archiving a task with auto-merge on records who switched it off", async () => {
    const id = idleTask();
    expect((await call(`/api/tasks/${id}/autopilot`, "PUT", WEB, { autoMerge: true, autoFix: true })).status).toBe(200);
    // no worktree to preflight: the archive is a bookkeeping flip
    setTaskFields(id, { worktree_path: null });
    expect((await call(`/api/tasks/${id}/archive`, "POST", agentHeaders("orch5"), { stopAutopilot: true })).status).toBe(200);
    expect(recorded(id, "autopilot")[0]).toMatchObject({ actor: "agent:orch5", detail: "auto-merge off, auto-fix off by archiving" });
    expect(recorded(id, "archive")).toEqual([expect.objectContaining({ actor: "agent:orch5" })]);
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
