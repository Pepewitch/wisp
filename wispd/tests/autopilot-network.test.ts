/**
 * Autopilot's resume after a turn that ended on the network (autopilot/network.ts):
 * paused, not failed; one workflow message after 1, 2, then 4 minutes; at most
 * three in a row, then today's "waiting for you"; never for another failure;
 * and a person's own message still goes as it always did.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAdapters } from "../src/adapters";
import { loadConfig } from "../src/config";
import { NETWORK_RESUME_MESSAGE } from "../src/autopilot/network";
import { autopilotHistory, autopilotStatus, checkAutopilotOnTaskEvent, setAutopilot } from "../src/autopilot/store";
import { listTasksRoute } from "../src/routes/tasks";
import { startNextQueuedMessage } from "../src/runner";
import { db, getTask, latestTurnForTask, messagesFor, runningTurn, setTaskFields } from "../src/store";
import type { ApiTaskListItem } from "../src/types";
import { doneTask, fakeGitHub, forgetTasks, pass, queue, runtime, seed, until } from "./autopilot-harness";

afterEach(forgetTasks);

const OFFLINE = "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)";

/**
 * A harness whose turns fail the way `script` says, one line per turn (the
 * last repeats): `net` ends on the network, `auth` on an expired login, `ok`
 * succeeds. Every prompt it was given is appended to `prompts`.
 */
function harness(script: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "wisp-autopilot-network-"));
  const prompts = join(dir, "prompts.log"), count = join(dir, "count");
  writeFileSync(join(dir, "script"), `${script.join("\n")}\n`);
  const body = [
    `n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n+1)) > '${count}'`,
    `printf '%s\\n<<end>>\\n' "$0" >> '${prompts}'`,
    `step=$(sed -n "$((n+1))p" '${dir}/script'); [ -n "$step" ] || step=$(tail -1 '${dir}/script')`,
    `case "$step" in net) echo '${OFFLINE}' >&2; exit 1;; auth) echo 'Invalid API key · Please run /login' >&2; exit 1;; *) printf 'done\\n';; esac`,
  ].join("\n");
  const adapters = validateAdapters({ net: { bin: "bash", exec: ["-c", body], parse: { format: "text" } } });
  return { dir, adapters, prompts: () => existsSync(prompts) ? readFileSync(prompts, "utf8").split("<<end>>\n").filter(Boolean) : [] };
}

/** A task under auto-fix, its first turn already run and settled the way the harness's script says. */
async function armedTask(script: string[]) {
  const net = harness(script);
  const task = doneTask({ harness: "net" });
  setTaskFields(task.id, { worktree_path: net.dir });
  setAutopilot(task.id, { autoFix: true });
  queue(task.id, "build the thing");
  expect(startNextQueuedMessage(task.id, net.adapters, loadConfig())).not.toBeNull();
  await settled(task.id);
  const clock = { now: Date.now() };
  const github = fakeGitHub();
  const rt = runtime(github.github, clock, net.adapters);
  return { ...net, task, clock, rt, github: github.state };
}

async function settled(taskId: string) {
  await until(() => !runningTurn(taskId) && ["done", "failed"].includes(getTask(taskId)!.state), "the turn to settle");
}

/** Run one pass `ms` after the task's latest turn ended. */
async function lookAfter(t: { rt: ReturnType<typeof runtime>; clock: { now: number }; task: { id: string } }, ms: number) {
  t.clock.now = Date.parse(latestTurnForTask(t.task.id)!.ended_at!) + ms;
  await pass(t.rt, t.task.id, t.clock);
}

const workflowMessages = (taskId: string) => messagesFor(taskId).filter((message) => message.origin === "workflow");
const nextCheckAt = (taskId: string) =>
  Date.parse((db.query("SELECT next_check_at FROM workflows WHERE task_id = ? AND type = 'pr-autopilot'").get(taskId) as { next_check_at: string }).next_check_at);

describe("a turn that ended on the network, under autopilot", () => {
  test("is a pause: no resume before its minute, then one workflow message that continues the task", async () => {
    const t = await armedTask(["net", "ok"]);
    expect(getTask(t.task.id)).toMatchObject({ state: "failed" });
    expect(getTask(t.task.id)!.state_detail).toStartWith("network: turn exited 1: API Error: Connection refused");
    await lookAfter(t, 30_000);
    const ended = Date.parse(latestTurnForTask(t.task.id)!.ended_at!);
    const status = autopilotStatus(t.task.id);
    expect(status.network).toEqual({ resumesAt: new Date(ended + 60_000).toISOString(), resume: 1, of: 3 });
    expect(status.reason).toBe("The network dropped — resuming in 1 min (1 of 3)");
    expect(workflowMessages(t.task.id)).toEqual([]);
    // the next look is the resume's own minute, and the GitHub budget does not stretch it
    expect(nextCheckAt(t.task.id)).toBe(ended + 60_000);
    // the task list says so, for the sidebar and `wisp ls`
    const listed = (await listTasksRoute(new URL("http://wisp/api/tasks")).json() as ApiTaskListItem[]).find((row) => row.id === t.task.id)!;
    expect(listed.autopilot?.network?.resume).toBe(1);

    await lookAfter(t, 60_000);
    const [message] = workflowMessages(t.task.id);
    expect(message?.text).toBe(NETWORK_RESUME_MESSAGE);
    expect(JSON.parse(message!.source_json!)).toMatchObject({ by: "autopilot", kind: "network-resume", round: null });
    await settled(t.task.id);
    expect(getTask(t.task.id)!.state).toBe("done");
    expect(t.prompts().at(-1)).toContain(NETWORK_RESUME_MESSAGE);
    expect(autopilotHistory(t.task.id).find((entry) => entry.kind === "network-resume")?.detail).toBe("Resumed after the network dropped (1 of 3)");
    expect(autopilotStatus(t.task.id).network).toBeNull();
  });

  test("backs off 1, 2, then 4 minutes, at most three resumes in a row, then waits for you", async () => {
    const t = await armedTask(["net"]);
    for (const [resume, waitMs] of [[1, 60_000], [2, 120_000], [3, 240_000]] as const) {
      await lookAfter(t, waitMs - 1_000);
      expect(autopilotStatus(t.task.id).network).toMatchObject({ resume, of: 3 });
      expect(workflowMessages(t.task.id)).toHaveLength(resume - 1);
      await lookAfter(t, waitMs);
      expect(workflowMessages(t.task.id)).toHaveLength(resume);
      await settled(t.task.id);
      expect(getTask(t.task.id)!.state_detail).toStartWith("network: ");
    }
    // the third resume dropped too: the task is failed, and waits for a person as any failed task does
    await lookAfter(t, 60 * 60_000);
    expect(workflowMessages(t.task.id)).toHaveLength(3);
    expect(autopilotStatus(t.task.id)).toMatchObject({ network: null, reason: "The task failed — waiting for you" });
    expect(getTask(t.task.id)!.turn_count).toBe(4);
  });

  test("a merge of its PR is not the task moving on: spent resumes stay spent", async () => {
    const t = await armedTask(["net"]);
    seed(t.task.id, t.clock);
    for (const waitMs of [60_000, 120_000, 240_000]) {
      await lookAfter(t, waitMs);
      await settled(t.task.id);
    }
    expect(workflowMessages(t.task.id)).toHaveLength(3);
    // someone merges the PR while the task waits for a person
    t.github.pr = { ...t.github.pr, state: "MERGED", mergedBy: "owner" };
    await lookAfter(t, 60 * 60_000);
    expect(autopilotStatus(t.task.id).lastMerged).toEqual({ pr: 7, byWisp: false });
    await lookAfter(t, 2 * 60 * 60_000);
    expect(workflowMessages(t.task.id)).toHaveLength(3);
    expect(autopilotStatus(t.task.id).network).toBeNull();
  });

  test("its resumes are their own history entries, never numbered as fix rounds", async () => {
    const t = await armedTask(["net", "ok"]);
    await lookAfter(t, 60_000);
    await settled(t.task.id);
    const kinds = autopilotHistory(t.task.id).map((entry) => entry.kind);
    expect(kinds).toContain("network-resume");
    expect(kinds).not.toContain("wake");
  });

  test("a turn that ends any other way starts the count over", async () => {
    const t = await armedTask(["net", "net", "ok", "net", "ok"]);
    await lookAfter(t, 60_000);
    await settled(t.task.id);
    await lookAfter(t, 120_000);
    await settled(t.task.id);
    expect(getTask(t.task.id)!.state).toBe("done");
    // the owner's next turn drops: it is resume 1 of 3 again, a minute after
    queue(t.task.id, "one more thing");
    startNextQueuedMessage(t.task.id, t.adapters, loadConfig());
    await settled(t.task.id);
    await lookAfter(t, 30_000);
    expect(autopilotStatus(t.task.id).network).toMatchObject({ resume: 1 });
    await lookAfter(t, 60_000);
    expect(workflowMessages(t.task.id)).toHaveLength(3);
    await settled(t.task.id);
    expect(getTask(t.task.id)!.state).toBe("done");
  });

  test("a person's own message while it is paused goes at once, as always, and counts as theirs", async () => {
    const t = await armedTask(["net", "net", "ok"]);
    await lookAfter(t, 60_000);
    await settled(t.task.id);
    await lookAfter(t, 30_000);
    expect(autopilotStatus(t.task.id).network).toMatchObject({ resume: 2 });
    // the wait describes a failed task: the person's turn starting brings the next look forward
    expect(checkAutopilotOnTaskEvent(t.task.id, "failed")).toBe(false);
    expect(checkAutopilotOnTaskEvent(t.task.id, "running")).toBe(true);
    queue(t.task.id, "carry on, the wifi is back");
    expect(startNextQueuedMessage(t.task.id, t.adapters, loadConfig())).not.toBeNull();
    await settled(t.task.id);
    expect(getTask(t.task.id)!.state).toBe("done");
    expect(t.prompts().at(-1)).toContain("carry on, the wifi is back");
    await lookAfter(t, 10 * 60_000);
    // no resume of Wisp's own went out after the person's
    expect(workflowMessages(t.task.id)).toHaveLength(1);
    expect(autopilotStatus(t.task.id).network).toBeNull();
  });
});

describe("never resumed", () => {
  test("a failure that is not the network (an expired login) waits for you at once", async () => {
    const t = await armedTask(["auth"]);
    expect(getTask(t.task.id)!.state_detail).toBe("turn exited 1: Invalid API key · Please run /login");
    await lookAfter(t, 10 * 60_000);
    expect(workflowMessages(t.task.id)).toEqual([]);
    expect(autopilotStatus(t.task.id)).toMatchObject({ network: null, reason: "The task failed — waiting for you" });
  });

  test("a task with autopilot off: nothing looks at it", async () => {
    const t = await armedTask(["net"]);
    setAutopilot(t.task.id, { autoFix: false });
    await lookAfter(t, 10 * 60_000);
    expect(workflowMessages(t.task.id)).toEqual([]);
    expect(getTask(t.task.id)!.state).toBe("failed");
  });
});
