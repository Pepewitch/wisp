/**
 * The GitHub half of the benchmark: one autopilot pass over armed PRs of one
 * repository, against the fake GitHub the budget tests use (it prices each
 * query by GitHub's documented formula, which matches what GitHub reports).
 * Nothing reaches GitHub. Run by run.ts as a child process on a home of its
 * own, because the daemon's paths are bound to WISP_HOME when its modules
 * load. Prints one JSON array on stdout.
 */
import { assertBenchHome, type Measurement } from "./shared";

const PRS = Number(process.argv[2] ?? "12");
assertBenchHome(process.env.WISP_HOME);

const { acquireHomeOwnership } = await import("../wispd/src/home-lock");
const store = await import("../wispd/src/store");
const { loadConfig } = await import("../wispd/src/config");
const { AutopilotRuntime } = await import("../wispd/src/autopilot/runtime");
const { createGhAutopilot } = await import("../wispd/src/autopilot/github");
const { autopilotRow, setAutopilot, writeAutopilotCheckpoint } = await import("../wispd/src/autopilot/store");
const { GitHubBudget } = await import("../wispd/src/github-budget");
const { fakeGh } = await import("../wispd/tests/github-fake");
const { HEAD, snapshot } = await import("../wispd/tests/autopilot-harness");

const ownership = acquireHomeOwnership();
store.initializeStore();
const cfg = loadConfig();
const clock = { now: Date.parse("2026-09-23T12:00:00Z") };
const past = new Date(clock.now - 10 * 60_000).toISOString();
const ids = Array.from({ length: PRS }, (_, index) => {
  const id = store.newTaskId();
  store.createTask({ id, title: `Bench PR ${index}`, repo_path: "/bench/repo", harness: "claude", model: null, slot: store.freeSlot() });
  store.setTaskFields(id, { worktree_path: "/bench/worktree", branch: `wisp/${id}-bench` });
  store.transition(id, "done");
  setAutopilot(id, { autoMerge: true }, new Date(clock.now));
  writeAutopilotCheckpoint(autopilotRow(id)!, { pr: 1000 + index, heads: { [HEAD]: past }, readySince: past }, new Date(clock.now));
  return id;
});

/** One pass, every row due: the requests it sent and the GraphQL points they cost. */
async function pass(batched: boolean): Promise<{ requests: number; points: number; detail: string }> {
  store.db.run("UPDATE workflows SET next_check_at = ? WHERE type = 'pr-autopilot'", [new Date(clock.now).toISOString()]);
  const budget = new GitHubBudget(() => clock.now);
  const gh = fakeGh({ clock, pr: (number) => snapshot({ number, url: `https://github.com/o/r/pull/${number}`, checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null, required: true, url: "" }] }) });
  const client = createGhAutopilot({ run: gh.run, budget });
  const runtime = new AutopilotRuntime(cfg, {}, {
    now: () => new Date(clock.now), budget, github: batched ? client : { ...client, snapshots: undefined },
    repository: async () => "o/r", branches: async (task) => [task.branch!], published: async () => ({ ok: true }),
  });
  await runtime.tick();
  const calls = gh.state.calls;
  const kinds = [...new Set(calls.map((call) => call.kind))].map((kind) => `${calls.filter((call) => call.kind === kind).length} ${kind}`);
  return { requests: calls.length, points: calls.filter((call) => call.kind === "graphql").reduce((sum, call) => sum + call.cost, 0), detail: kinds.join(", ") };
}

const batched = await pass(true);
const alone = await pass(false);
for (const id of ids) store.db.run("DELETE FROM tasks WHERE id = ?", [id]);
ownership.release();
const results: Measurement[] = [
  { name: "github.autopilotPass.requests", value: batched.requests, unit: `requests for ${PRS} PRs`, detail: batched.detail },
  { name: "github.autopilotPass.points", value: batched.points, unit: `GraphQL points for ${PRS} PRs` },
  { name: "github.autopilotPassUnbatched.requests", value: alone.requests, unit: `requests for ${PRS} PRs`, informational: true },
];
console.log(JSON.stringify(results));
