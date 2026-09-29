/** `wisp new`: create a task, then say what the daemon actually armed. */
import { discardAttachment, daemonRequest, exitApi, uploadAttachment } from "./cli-api";
import type { Flags } from "./cli-args";
import { discardAttachmentPayloads, readAttachmentFlags } from "./cli-attach";
import { print, printError } from "./cli-print";
import { wispCommand } from "./command";
import type { StagedAttachmentPayload } from "./attachments";
import { resolve } from "node:path";
import type { ApiTask } from "./types";

const COMMAND = wispCommand();

export async function createCommand(positional: string[], flags: Flags): Promise<void> {
  let repo: string, prompt: string;
  if (positional.length >= 2) {
    [repo, prompt] = [positional[0]!, positional.slice(1).join(" ")];
  } else if (positional.length === 1) {
    [repo, prompt] = [process.cwd(), positional[0]!];
  } else {
    printError(
      `usage: ${COMMAND} new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--fast] [--local] [--base <ref>] [--auto-merge] [--auto-fix] [--brief] [--attach <path>]…`,
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
  let attachments: StagedAttachmentPayload[] | undefined;
  try {
    attachments = await readAttachmentFlags(flags, uploadAttachment, discardAttachment);
  } catch (error) {
    exitApi(error);
  }
  let task: ApiTask;
  try {
    task = await daemonRequest("/api/tasks", "POST", JSON.stringify({
      repoPath: resolve(repo),
      prompt,
      harness,
      model: typeof flags.model === "string" ? flags.model : undefined,
      effort: typeof flags.effort === "string" ? flags.effort : undefined,
      fast: flags.fast === true ? true : undefined,
      mode: flags.local ? "local" : undefined,
      base: typeof flags.base === "string" ? flags.base : undefined,
      autopilot: flags["auto-merge"] === true || flags["auto-fix"] === true
        ? { autoMerge: flags["auto-merge"] === true, autoFix: flags["auto-fix"] === true }
        : undefined,
      briefEnabled: flags.brief === true ? true : undefined,
      attachments,
    })) as ApiTask;
  } catch (error) {
    if (attachments) await discardAttachmentPayloads(attachments, discardAttachment);
    exitApi(error);
  }
  reportCreated(task, flags);
}

/** What the daemon armed, not what was asked: an older daemon ignores the fields it does not know. */
function reportCreated(task: ApiTask, flags: Flags): void {
  const where = task.mode === "local" ? ", local" : "";
  const autopilot = (task as ApiTask & { autopilot?: { autoMerge?: boolean; autoFix?: boolean } }).autopilot;
  const merge = [autopilot?.autoMerge && ", auto-merge", autopilot?.autoFix && ", auto-fix"].filter(Boolean).join("");
  const brief = task.briefEnabled === true ? ", brief" : "";
  print(`created ${task.id} (${task.harness}${task.model ? `, ${task.model}` : ""}${where}${merge}${brief}) — ${task.title}`);
  const asked = flags["auto-merge"] === true || flags["auto-fix"] === true;
  if (asked && !autopilot?.autoMerge && !autopilot?.autoFix) printError("warning: this daemon did not arm auto-merge or auto-fix (it may be older than this CLI)");
  if (flags.brief === true && task.briefEnabled !== true) printError("warning: this daemon did not turn briefs on (it may be older than this CLI)");
}
