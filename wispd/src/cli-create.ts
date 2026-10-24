/** `wisp new`: create a task, then say what the daemon actually armed. */
import { discardAttachment, daemonRequest, exitApi, uploadAttachment } from "./cli-api";
import type { Flags } from "./cli-args";
import { discardAttachmentPayloads, readAttachmentFlags } from "./cli-attach";
import { print, printError } from "./cli-print";
import { requireSubtasks, subtaskFlags } from "./cli-subtasks";
import { wispCommand } from "./command";
import type { StagedAttachmentPayload } from "./attachments";
import { resolve } from "node:path";
import type { ApiTask } from "./types";

const COMMAND = wispCommand();

export async function createCommand(positional: string[], flags: Flags): Promise<void> {
  // refused, not ignored: a script that asked for a brief must learn it gets none
  if (flags.brief !== undefined) {
    printError("--brief is no longer supported: Wisp removed task briefs. Run the command again without it.");
    process.exit(1);
  }
  // a subtask's repository is its parent's, so the current directory is no default for one
  const subtask = subtaskFlags(flags);
  let repo: string | null, prompt: string;
  if (positional.length >= 2) {
    [repo, prompt] = [positional[0]!, positional.slice(1).join(" ")];
  } else if (positional.length === 1) {
    [repo, prompt] = [subtask ? null : process.cwd(), positional[0]!];
  } else {
    printError(
      `usage: ${COMMAND} new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--fast] [--local] [--base <ref>] [--auto-merge] [--auto-fix] [--auto-review] [--attach <path>]…`,
    );
    process.exit(1);
  }
  const harness = flags.harness;
  if (typeof harness !== "string") {
    printError("--harness is required (e.g. --harness droid)");
    process.exit(1);
  }
  if (flags.effort !== undefined && typeof flags.effort !== "string") {
    printError("--effort requires a value");
    process.exit(1);
  }
  if (flags.base !== undefined && typeof flags.base !== "string") {
    printError("--base requires a value (e.g. --base origin/develop)");
    process.exit(1);
  }
  // before any upload: an older daemon would otherwise make a root task, after staging files for it
  if (subtask) await requireSubtasks();
  let attachments: StagedAttachmentPayload[] | undefined;
  try {
    attachments = await readAttachmentFlags(flags, uploadAttachment, discardAttachment);
  } catch (error) {
    exitApi(error);
  }
  let task: ApiTask;
  try {
    task = await daemonRequest("/api/tasks", "POST", JSON.stringify({
      ...(repo === null ? {} : { repoPath: resolve(repo) }),
      ...(subtask ?? {}),
      prompt,
      harness,
      model: typeof flags.model === "string" ? flags.model : undefined,
      effort: typeof flags.effort === "string" ? flags.effort : undefined,
      fast: flags.fast === true ? true : undefined,
      mode: flags.local ? "local" : undefined,
      base: typeof flags.base === "string" ? flags.base : undefined,
      autopilot: flags["auto-merge"] === true || flags["auto-fix"] === true || flags["auto-review"] === true
        ? {
          autoMerge: flags["auto-merge"] === true, autoFix: flags["auto-fix"] === true,
          // only when asked: an older daemon refuses a field it does not know
          ...(flags["auto-review"] === true ? { autoReview: true } : {}),
        }
        : undefined,
      attachments,
    })) as ApiTask;
  } catch (error) {
    if (attachments) await discardAttachmentPayloads(attachments, discardAttachment);
    exitApi(error);
  }
  reportCreated(task, flags, repo === null ? task.repo_path : resolve(repo));
}

/** What the daemon armed, not what was asked: an older daemon ignores the fields it does not know. */
function reportCreated(task: ApiTask, flags: Flags, asked: string): void {
  const where = task.mode === "local" ? ", local" : "";
  const autopilot = (task as ApiTask & { autopilot?: { autoMerge?: boolean; autoFix?: boolean; autoReview?: boolean } }).autopilot;
  const merge = [autopilot?.autoMerge && ", auto-merge", autopilot?.autoFix && ", auto-fix", autopilot?.autoReview && ", auto-review"].filter(Boolean).join("");
  const family = task.parent_task_id ? `, ${task.subtask_kind} subtask of ${task.parent_task_id}` : "";
  print(`created ${task.id} (${task.harness}${task.model ? `, ${task.model}` : ""}${where}${merge}${family}) — ${task.title}`);
  // the daemon takes a path inside another worktree back to its project's checkout
  if (task.repo_path !== asked) print(`repository: ${task.repo_path} (${asked} is inside a worktree of it)`);
  const askedAutopilot = flags["auto-merge"] === true || flags["auto-fix"] === true;
  if (askedAutopilot && !autopilot?.autoMerge && !autopilot?.autoFix) printError("warning: this daemon did not arm auto-merge or auto-fix (it may be older than this CLI)");
  if (flags["auto-review"] === true && !autopilot?.autoReview) printError("warning: this daemon did not arm auto-review (it may be older than this CLI)");
}
