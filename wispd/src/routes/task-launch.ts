/**
 * The task-creation flow, from a persisted row to a running turn.
 *
 * Its own module because it is the one part of the tasks routes that is not
 * a request handler: it runs AFTER the response, so nothing here may assume
 * a caller is still waiting, and every failure has to land on the task
 * itself rather than in a rejected promise.
 */
import type { AdapterDef } from "../adapters";
import { writeTurnAttachments, type DecodedAttachment } from "../attachments";
import type { WispConfig } from "../config";
import { homeIsDraining } from "../home-lifetime";
import { startTurn, taskEnv } from "../runner";
import { getTask, setTaskFields, transition } from "../store";
import { taskMode, type Task } from "../types";
import { createWorktree, localWorktree, runSetup } from "../worktree";

/**
 * Full task-creation flow, run async after the record is persisted (spawn
 * contract rule 1). Turn-1 attachments ride along in memory (validated at
 * request time) and are written to disk only once creation got as far as
 * spawning the turn — a failed worktree/setup leaves no orphan files.
 */
export async function launchTask(
  task: Task,
  prompt: string,
  def: AdapterDef,
  adapters: Record<string, AdapterDef>,
  cfg: WispConfig,
  attachments: DecodedAttachment[] = [],
  base?: string,
): Promise<void> {
  try {
    const mode = taskMode(task);
    // local: adopt the checkout as-is, creating nothing. worktree: the
    // original path — a fresh worktree on its own branch.
    const wt =
      mode === "local"
        ? await localWorktree(task.repo_path)
        : await createWorktree(task.repo_path, task.id, cfg, base);
    setTaskFields(task.id, {
      worktree_path: wt.path,
      branch: wt.branch,
      base_commit: wt.base_commit,
      base_ref: wt.base_ref,
    });
    // Still 'creating', but the worktree now EXISTS — re-emit so watchers
    // refetch and pick up worktree_path. Setup can run for minutes, and until
    // this fires the web terminal has no directory to open a shell in.
    //
    // A base that had to be substituted says so HERE rather than only in a
    // log: a task quietly forked from the wrong commit is the whole defect,
    // so the one case where Wisp picked something other than what the project
    // asked for is the one case worth spending the detail line on.
    //
    // The detail line is transient — the next transition overwrites it — so
    // the same sentence also goes to the daemon log, where it survives long
    // enough for someone to find it after the task has moved on. `base_ref`
    // on the row is the durable record of what was actually used.
    if (wt.base_note) console.warn(`[wisp] task ${task.id}: ${wt.base_note}; used ${wt.base_ref ?? "the checkout's HEAD"}`);
    transition(
      task.id,
      "creating",
      mode === "local"
        ? "using the checkout"
        : wt.base_note
          ? `${wt.base_note} — running setup`
          : "worktree ready, running setup",
    );
    // Setup exists to make a FRESH worktree usable. Running it over the user's
    // own checkout is destructive (it is where `pnpm install` and friends
    // live), so a local task never runs it.
    if (mode === "worktree") await runSetup(task.id, task.repo_path, wt.path, taskEnv(getTask(task.id)!), cfg);
    // Archive may have completed while setup yielded. Its read-only flip wins;
    // never start a child in a worktree teardown is already removing.
    const fresh = getTask(task.id);
    if (!fresh || fresh.archived || homeIsDraining()) return;
    const stored = attachments.length > 0 ? writeTurnAttachments(task.id, fresh.turn_count + 1, attachments) : [];
    startTurn(fresh, prompt, def, cfg, stored, undefined, adapters);
  } catch (e) {
    if (getTask(task.id)?.archived) return;
    transition(task.id, "failed", String(e instanceof Error ? e.message : e).slice(0, 300));
  }
}
