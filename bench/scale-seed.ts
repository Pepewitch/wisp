/**
 * The seeding half of `bun run bench:scale`: one long task and one parent
 * with subtasks, all finished and each in its own live worktree, plus a long
 * archived history, written through the store's own writers. A child process
 * because the store binds WISP_HOME when its modules load. Prints nothing on
 * success.
 *
 * Rows look like a real home's: every turn is recorded (its outcome
 * checkpoint repeats the result), every task carries the skill list its
 * session announced, and some archived tasks had autopilot on.
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
  /** archived tasks of a few turns each, every fourth of which had autopilot */
  archived: number;
}

const plan = JSON.parse(process.argv[2] ?? "null") as ScalePlan;
assertBenchHome(process.env.WISP_HOME);

const { LOG_DIR } = await import("../wispd/src/config");
const { acquireHomeOwnership } = await import("../wispd/src/home-lock");
const store = await import("../wispd/src/store");
// a namespace import: `db` is a live binding, set only once the store is initialized
const storeDatabase = await import("../wispd/src/store-database");
const { putTurnText, TURN_TEXT_PROSE } = await import("../wispd/src/turn-texts");
const { setAutopilot } = await import("../wispd/src/autopilot/store");

const ownership = acquireHomeOwnership();
store.initializeStore();

/** An orchestrator's mix: work it hands off, reviews of that work, and explorations. */
const KINDS = ["continue", "review", "explore"] as const;
/** What a Claude session's init event announces: a few dozen skill names. */
const SKILLS = JSON.stringify(Array.from({ length: 60 }, (_, i) => `plugin-${i % 7}:skill-${i}-${text(12).replace(/\W+/g, "-")}`));

let worktree = 0;
function seedTask(id: string, turns: number, parent?: { id: string; kind: (typeof KINDS)[number] }, archived = false): void {
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
    const turnId = store.createTurn(id, n, text(200 + (n * 97) % 1500), null, log, null, null, "recorder-v1");
    const result = text(200 + (n * 131) % 3000);
    store.setTurnCaptureCheckpoint(turnId, {
      state: "complete", capturedBytes: 0, omittedBytes: 0, omittedRecords: 0, categoriesJson: null, detail: null,
      outcomeJson: JSON.stringify({ version: 1, outcome: { result, finalText: result, sessionId: `s-${id}` } }),
    });
    store.finishTurn(turnId, "done", 0, result);
    const prose = text(400 + (n * 389) % 12_000);
    putTurnText({ turn_id: turnId, kind: TURN_TEXT_PROSE, task_id: id, text: prose, bytes: prose.length, state: "complete" });
  }
  // an archived task's worktree is gone; a live one has its own
  const path = archived ? join(plan.repo, "..", "worktrees", `gone-${id}`) : plan.worktrees[worktree++]!;
  store.setTaskFields(id, { worktree_path: path, branch: `wisp/${id}`, base_commit: plan.base, turn_count: turns, skills_json: SKILLS, session_id: `s-${id}` });
  store.transition(id, "done", `turn ${turns}`);
}

storeDatabase.db.transaction(() => {
  // the archived history first, so its rows are older than the live ones
  for (let i = 0; i < plan.archived; i++) {
    const id = `arch${i}`;
    seedTask(id, 3, undefined, true);
    if (i % 4 === 0) setAutopilot(id, { autoFix: true });
    store.setTaskFields(id, { archived: 1 });
  }
  seedTask("long", plan.longTurns);
  seedTask("parent", plan.parentTurns);
  for (let i = 0; i < plan.subtasks; i++) seedTask(`sub${i}`, plan.subtaskTurns, { id: "parent", kind: KINDS[i % KINDS.length]! });
})();
ownership.release();
