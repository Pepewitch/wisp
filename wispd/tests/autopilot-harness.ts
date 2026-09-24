/**
 * The autopilot suites' shared fixtures: a done task, a PR snapshot, a fake
 * GitHub that records every merge, a runtime on a controllable clock, and a
 * harness that writes the prompt it was given.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdapters } from "../src/adapters";
import { loadConfig } from "../src/config";
import type { AutopilotGitHub, OpenPullRequest, PrSnapshot } from "../src/autopilot/github";
import { AutopilotRuntime } from "../src/autopilot/runtime";
import { autopilotRow, writeAutopilotCheckpoint } from "../src/autopilot/store";
import { taskMessageAttachmentsFingerprint } from "../src/attachments";
import { createTask, createTaskMessage, db, freeSlot, getTask, newTaskId, newTaskMessageId, setTaskFields, transition } from "../src/store";
import type { Task } from "../src/types";

export const HEAD = "c".repeat(40);
export const START = Date.parse("2026-09-23T12:00:00Z");
export const created: string[] = [];
/** Register with `afterEach(forgetTasks)` in each file that uses these fixtures. */
export function forgetTasks(): void { for (const id of created.splice(0)) db.run("DELETE FROM tasks WHERE id = ?", [id]); }

export function doneTask(over: Partial<Parameters<typeof createTask>[0]> = {}): Task {
  const id = newTaskId();
  createTask({ id, title: "Autopilot fixture", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot(), ...over });
  created.push(id);
  setTaskFields(id, { worktree_path: "/fixture/worktree", branch: `wisp/${id}-fixture` });
  transition(id, "done");
  return getTask(id)!;
}

export function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, isCrossRepository: false,
    head: HEAD, headRefName: "wisp/fixture", baseRefName: "main", defaultBranch: "main", mergeState: "CLEAN",
    reviewDecision: null, queued: false, providerAutoMerge: false, mergedBy: null, viewer: "owner",
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", required: true, url: "" }],
    actionsSuitesPending: 0, actionsSuitesWaiting: 0, reviews: [], threads: [], threadsTruncated: false, comments: [], unresolvedThreads: 0, mergeMethod: "SQUASH",
    baseHead: null, baseChecks: [], ...over,
  };
}

/** A PR the task could have opened: by the viewer, after the task existed. */
export function pull(over: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return { number: 7, headRefName: "wisp/fixture", baseRefName: "main", createdAt: new Date(Date.now() + 60_000).toISOString(), isCrossRepository: false, author: "owner", ...over };
}

/** A fake GitHub the test can steer, and that records every merge it is asked for. */
export function fakeGitHub(initial: { pulls?: OpenPullRequest[]; pr?: PrSnapshot } = {}) {
  const state = {
    pulls: initial.pulls ?? [pull()],
    pr: initial.pr ?? snapshot(),
    required: ["test"],
    merges: [] as { number: number; method: string; head: string }[],
    mergeResult: { ok: true, detail: "" } as { ok: boolean; detail: string },
    onMerge: null as null | (() => Promise<void> | void),
    onSnapshot: null as null | (() => void),
    reruns: [] as number[],
    logs: null as null | ((jobId: number, signal: AbortSignal) => string | Promise<string>),
    rerunOk: true,
    pushers: [] as string[],
  };
  const github: AutopilotGitHub = {
    async snapshot() { state.onSnapshot?.(); return structuredClone(state.pr); },
    async openPullRequests() { return { defaultBranch: "main", viewer: "owner", pulls: state.pulls }; },
    async requiredChecks() { return state.required; },
    async merge(input) {
      state.merges.push({ number: input.number, method: input.method, head: input.head });
      await state.onMerge?.();
      if (state.mergeResult.ok) state.pr = { ...state.pr, state: "MERGED", mergedBy: "owner" };
      return state.mergeResult;
    },
    async rerunRun(_repository, runId) { state.reruns.push(runId); return state.rerunOk; },
    async jobLogTail(_repository, jobId, _cwd, signal) {
      return state.logs ? await state.logs(jobId, signal) : `log of job ${jobId}\n(fail) retry never stops\n##[error]Process completed with exit code 1.`;
    },
    async checkRunReport() { return "a report"; },
    async canPush(_repository, login) { return state.pushers.includes(login); },
  };
  return { state, github };
}

export function runtime(github: AutopilotGitHub, clock: { now: number }, adapters = {}, cfg = loadConfig(), lookTimeoutMs?: number) {
  return new AutopilotRuntime(cfg, adapters, {
    now: () => new Date(clock.now), github, lookTimeoutMs,
    repository: async () => "o/r", branches: async (task) => [task.branch!],
    published: async () => ({ ok: true }),
  });
}

/** Bound to #7, with its head and its ready-for-review long enough ago that checks are believed. */
export function seed(taskId: string, clock: { now: number }, extra: Record<string, unknown> = {}) {
  const past = new Date(START).toISOString();
  writeAutopilotCheckpoint(autopilotRow(taskId)!, { pr: 7, heads: { [HEAD]: past }, readySince: past, ...extra }, new Date(clock.now));
}

/** Make the row due and run one pass. */
export async function pass(rt: AutopilotRuntime, taskId: string, clock: { now: number }) {
  db.run("UPDATE workflows SET next_check_at = ? WHERE task_id = ? AND type = 'pr-autopilot' AND state != 'completed'", [new Date(clock.now).toISOString(), taskId]);
  await rt.tick();
}

export async function until(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A harness that writes the prompt it was given to a file, so a test can read exactly what the agent saw. */
export function capture() {
  const dir = mkdtempSync(join(tmpdir(), "wisp-autopilot-turn-"));
  const file = join(dir, "prompt.txt");
  // written aside and moved into place, so a test that sees the file sees all of it
  const adapters = validateAdapters({ capture: { bin: "bash", exec: ["-c", `printf '%s' "$0" > '${file}.part' && mv '${file}.part' '${file}'; printf 'done\\n'`], parse: { format: "text" } } });
  return { dir, file, adapters };
}
export function queue(taskId: string, text: string) {
  createTaskMessage({ id: newTaskMessageId(), taskId, text, attachmentHash: taskMessageAttachmentsFingerprint([]) });
}
