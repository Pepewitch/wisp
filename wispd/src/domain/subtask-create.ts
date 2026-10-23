/**
 * Creating a subtask: every rule between "this task names a parent" and the
 * row. task-create.ts calls it before anything else is decided, so a refused
 * subtask leaves no row, no staged attachment and no worktree behind.
 *
 * Wisp's own reviewers come through here too (`verifyRole: reviewer`): they
 * are review subtasks of the task whose PR they review, exempt from the
 * feature flag, the caps and the PR lookup, since auto-review hands them the
 * head it already resolved.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { autopilotStatus } from "../autopilot/store";
import { originRepository } from "../autopilot/bind";
import { ghAutopilot, type AutopilotGitHub } from "../autopilot/github";
import { subtasksEnabled, totalSubtaskCap } from "../config-subtasks";
import type { WispConfig } from "../config";
import { getTask } from "../store";
import { liveNonReviewerChildren } from "../subtasks";
import { READ_TIMEOUT_MS, runBounded } from "../subprocess";
import { taskMode, type SubtaskKind, type Task } from "../types";
import { relayed } from "../verify/prompts";
import type { NewTaskInput, NewTaskRefusal } from "./task-create";

/** A base resolved before the row exists, used as given by createWorktree. */
export interface PinnedBase {
  ref: string;
  commit: string;
  /** provenance, stored as base_from: pr#<n> or parent:<id> */
  from: string;
}

export interface SubtaskRequest {
  parentId: string;
  /** defaults to `explore`, and to `review` for Wisp's reviewers */
  kind?: SubtaskKind;
  /** report each turn back to the parent; off unless asked */
  report?: boolean;
}

export interface ResolvedSubtask {
  parent: Task;
  kind: SubtaskKind;
  report: boolean;
  reviewer: boolean;
  /** pinned now (review, continue), a ref createWorktree resolves (explicit), or the project's base (explore) */
  base: string | PinnedBase | undefined;
  baseFrom: string;
}

/** What creation asks of GitHub and git, injected so tests need neither. */
export interface SubtaskDeps {
  github: Pick<AutopilotGitHub, "openPullRequests">;
  origin: (parent: Task, signal: AbortSignal) => Promise<string | null>;
}

export const defaultSubtaskDeps: SubtaskDeps = { github: ghAutopilot, origin: originRepository };

/** A rule that held when the request was checked and no longer did when the row was written. */
export class SubtaskRefused extends Error {
  constructor(readonly refusal: Exclude<NewTaskRefusal, { kind: "attachment" }>) {
    super(refusal.error);
  }
}

type Refusal = Exclude<NewTaskRefusal, { kind: "attachment" }>;
const refuse = (kind: Refusal["kind"], error: string): Refusal => ({ kind, error });

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await runBounded({ cmd: ["git", ...args], cwd, env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: READ_TIMEOUT_MS });
    return result.exitCode === 0 ? result.out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The parent as it must be for this child: present, live, a root (a reviewer
 * may sit under a subtask), and with room under the total cap. Checked when
 * the request arrives and again inside the insert's transaction.
 */
export function parentRefusal(parentId: string, reviewer: boolean, cfg: WispConfig): Refusal | null {
  const parent = getTask(parentId);
  if (!parent) return refuse("invalid", `no such parent task: ${parentId}`);
  if (parent.archived) return refuse("conflict", `task ${parent.id} is archived; a subtask needs a live parent`);
  if (parent.verify_role) return refuse("conflict", `task ${parent.id} was started by Wisp for verification and cannot have subtasks`);
  if (!reviewer && (parent.parent_task_id || parent.subtask_kind)) {
    const root = parent.parent_task_id ? ` use --parent ${parent.parent_task_id}` : " use a root task";
    return refuse("conflict", `subtasks have one level: task ${parent.id} is itself a subtask;${root}`);
  }
  if (reviewer) return null;
  const live = liveNonReviewerChildren(parent.id).length;
  const cap = totalSubtaskCap(cfg);
  if (live >= cap) {
    return refuse("subtask-cap", `task ${parent.id} already has ${live} live subtasks, its limit; archive one first, or raise maxSubtasks in config.json`);
  }
  return null;
}

/** The parent's open PR head, fetched and verified, or why there is none. */
async function reviewBase(parent: Task, deps: SubtaskDeps): Promise<PinnedBase | Refusal> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const repository = await deps.origin(parent, signal);
  if (!repository) return refuse("conflict", `task ${parent.id}'s repository has no GitHub origin; pass --base`);
  // the PR autopilot already watches: never a fork, so no GitHub call is needed
  const watched = autopilotStatus(parent.id);
  // never a finished row's PR: a merged one is history, not the head to review
  let number = watched.state !== "off" && watched.state !== "merged" ? watched.pr : null;
  if (number === null) {
    if (!parent.branch) return refuse("conflict", `task ${parent.id} has no branch yet, so no PR; pass --base`);
    let pulls;
    try {
      pulls = (await deps.github.openPullRequests(repository, [parent.branch], parent.repo_path, signal)).pulls;
    } catch {
      return refuse("conflict", `couldn't reach GitHub to find task ${parent.id}'s PR; retry, or pass --base`);
    }
    const pull = pulls.find((candidate) => candidate.headRefName === parent.branch);
    if (!pull) return refuse("conflict", `task ${parent.id} has no open PR; pass --base`);
    if (pull.isCrossRepository) return refuse("conflict", `task ${parent.id}'s PR #${pull.number} is from a fork; pass --base`);
    number = pull.number;
  }
  const ref = `refs/pull/${number}/head`;
  const listed = await git(["ls-remote", "origin", ref], parent.repo_path);
  const commit = listed?.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return refuse("conflict", `couldn't read PR #${number}'s head from origin; retry, or pass --base`);
  await git(["fetch", "--no-tags", "--quiet", "origin", `+${ref}`], parent.repo_path);
  if ((await git(["cat-file", "-e", `${commit}^{commit}`], parent.repo_path)) === null) {
    return refuse("conflict", `couldn't fetch PR #${number}'s head ${commit.slice(0, 7)}; retry, or pass --base`);
  }
  return { ref, commit, from: `pr#${number}` };
}

/** The parent's committed branch tip. */
async function continueBase(parent: Task): Promise<PinnedBase | Refusal> {
  if (parent.state === "creating" || !parent.branch) return refuse("conflict", `task ${parent.id} is still being created; its branch has nothing to continue yet`);
  const commit = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${parent.branch}^{commit}`], parent.repo_path);
  if (!commit) return refuse("conflict", `task ${parent.id}'s branch ${parent.branch} does not resolve`);
  return { ref: parent.branch, commit, from: `parent:${parent.id}` };
}

/**
 * The request's subtask, resolved, or why it is refused; null when the
 * request names no parent. Every refusal comes before the row exists.
 */
export async function resolveSubtask(
  input: NewTaskInput,
  cfg: WispConfig,
  deps: SubtaskDeps = defaultSubtaskDeps,
): Promise<ResolvedSubtask | Refusal | null> {
  const request = input.subtask;
  if (!request) return null;
  const reviewer = input.verifyRole === "reviewer";
  if (!reviewer && !subtasksEnabled(cfg)) return refuse("conflict", "subtasks are not enabled on this daemon");
  const parentRefused = parentRefusal(request.parentId, reviewer, cfg);
  if (parentRefused) return parentRefused;
  const parent = getTask(request.parentId)!;
  const kind = request.kind ?? (reviewer ? "review" : "explore");
  if (input.mode === "local") return refuse("invalid", "a subtask runs in its own worktree; local mode is refused");
  if (kind === "continue" && taskMode(parent) === "local") {
    return refuse("invalid", `continue starts from the parent's branch, and task ${parent.id} runs on the checkout's own`);
  }
  if (input.repoPath && real(input.repoPath) !== real(parent.repo_path)) {
    return refuse("invalid", `a subtask uses its parent's repository (${parent.repo_path}); omit the repository`);
  }
  const autopilot = input.autopilot;
  if (!reviewer && (autopilot?.autoMerge || autopilot?.autoFix || autopilot?.autoReview)) {
    return refuse("conflict", "auto-merge, auto-fix and auto-review are not available on subtasks yet");
  }
  const resolved = { parent, kind, report: !reviewer && request.report === true, reviewer };
  if (typeof input.base === "object") return { ...resolved, base: input.base, baseFrom: input.base.from };
  // an explicit base wins over the kind's, so a fork PR's review child can still be given one
  if (input.base !== undefined) return { ...resolved, base: input.base, baseFrom: "explicit" };
  if (kind === "explore") return { ...resolved, base: undefined, baseFrom: "project" };
  const pinned = kind === "review" ? await reviewBase(parent, deps) : await continueBase(parent);
  if ("error" in pinned) return pinned;
  return { ...resolved, base: pinned, baseFrom: pinned.from };
}

/** The parent's goal for its child's first prompt: a person's title, else what it was first asked, else its title. */
function parentGoal(parent: Task, firstPrompt: string | null): string {
  if (parent.custom_title) return parent.title;
  const asked = firstPrompt?.trim();
  return asked ? asked : parent.title;
}

/**
 * A child's first prompt: the words it was given, then its parent, quoted.
 * The parent's goal is a person's or an agent's words, so it travels outside
 * Wisp's section, as quoted data that cannot open or close one.
 */
export function subtaskFirstPrompt(prompt: string, parent: Task, firstPrompt: string | null): string {
  return [prompt, "", `Parent task ${parent.id}, quoted:`, ...relayed(parentGoal(parent, firstPrompt), 2000)].join("\n");
}
