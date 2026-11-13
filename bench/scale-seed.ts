/**
 * The seeding half of `bun run bench:scale`: one long task and one parent
 * with subtasks, all finished and each in its own live worktree, written
 * through the store's own writers. A child process because the store binds
 * WISP_HOME when its modules load. Prints nothing on success.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertBenchHome, text } from "./shared";

export interface ScalePlan {
  repo: string;
  base: string;
  /** one existing worktree per task, in seeding order: long, parent, then each subtask */
  worktrees: string[];
  longTurns: number;
  parentTurns: number;
  subtasks: number;
  subtaskTurns: number;
}

const plan = JSON.parse(process.argv[2] ?? "null") as ScalePlan;
assertBenchHome(process.env.WISP_HOME);

const { LOG_DIR } = await import("../wispd/src/config");
const { acquireHomeOwnership } = await import("../wispd/src/home-lock");
const store = await import("../wispd/src/store");
// a namespace import: `db` is a live binding, set only once the store is initialized
const storeDatabase = await import("../wispd/src/store-database");
const { putTurnText, TURN_TEXT_PROSE } = await import("../wispd/src/turn-texts");

const ownership = acquireHomeOwnership();
store.initializeStore();

/** An orchestrator's mix: work it hands off, reviews of that work, and explorations. */
const KINDS = ["continue", "review", "explore"] as const;

let worktree = 0;
function seedTask(id: string, turns: number, parent?: { id: string; kind: (typeof KINDS)[number] }): void {
  store.createTask({
    id,
    title: `Scale ${id}`,
    repo_path: plan.repo,
    harness: "claude",
    model: "opus",
    slot: store.freeSlot(),
    ...(parent ? { subtask: { parent_task_id: parent.id, subtask_kind: parent.kind, report_to_parent: true, base_from: `parent:${parent.id}` } } : {}),
  });
  for (let n = 1; n <= turns; n++) {
    const log = join(LOG_DIR, `${id}-turn${n}.out.log`);
    writeFileSync(log, "");
    // the same prompt/result/prose shapes as bench/db.ts, so the two benches compare
    const turnId = store.createTurn(id, n, text(200 + (n * 97) % 1500), null, log);
    store.finishTurn(turnId, "done", 0, text(200 + (n * 131) % 3000));
    const prose = text(400 + (n * 389) % 12_000);
    putTurnText({ turn_id: turnId, kind: TURN_TEXT_PROSE, task_id: id, text: prose, bytes: prose.length, state: "complete" });
  }
  const index = worktree++;
  store.setTaskFields(id, { worktree_path: plan.worktrees[index]!, branch: `wisp/live${index}`, base_commit: plan.base, turn_count: turns });
  store.transition(id, "done", `turn ${turns}`);
}

storeDatabase.db.transaction(() => {
  seedTask("long", plan.longTurns);
  seedTask("parent", plan.parentTurns);
  for (let i = 0; i < plan.subtasks; i++) seedTask(`sub${i}`, plan.subtaskTurns, { id: "parent", kind: KINDS[i % KINDS.length]! });
})();
ownership.release();
