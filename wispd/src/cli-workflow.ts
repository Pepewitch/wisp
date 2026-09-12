import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Workflow, WorkflowDefinition, WorkflowDetail, WorkflowParams } from "../../shared/workflows";
import type { Flags } from "./cli-args";
import { wispCommand } from "./command";
import { isRecord } from "./validate";

type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export function workflowDuration(value: unknown): number {
  const match = typeof value === "string" ? value.match(/^([1-9][0-9]*)(m|h|d)$/) : null;
  if (!match) throw new Error("Use a duration such as 5m, 2h, or 1d");
  return Number(match[1]) * (match[2] === "d" ? 1440 : match[2] === "h" ? 60 : 1);
}
export function workflowFlags(flags: Flags): WorkflowParams {
  const allowed = new Set(["json", "params", "pr", "prompt", "file", "at", "every", "on-red", "on-green", "quiet-for", "lifetime", "max-wakeups", "reviewers", "exclude-authors", "allow-push", "allow-merge", "include-bots"]);
  for (const flag of Object.keys(flags)) if (!allowed.has(flag)) throw new Error(`Unknown workflow flag: --${flag}`);
  if (flags.params !== undefined && typeof flags.params !== "string") throw new Error("--params needs a JSON object");
  const raw: unknown = typeof flags.params === "string" ? JSON.parse(flags.params) : {};
  if (!isRecord(raw)) throw new Error("--params must be a JSON object");
  const params = { ...raw } as WorkflowParams;
  const strings: Record<string, string> = { pr: "prUrl", prompt: "prompt", at: "scheduledAt", "on-red": "onRed", "on-green": "onGreen", reviewers: "reviewers", "exclude-authors": "excludeAuthors" };
  for (const [flag, key] of Object.entries(strings)) {
    if (flags[flag] !== undefined) {
      if (typeof flags[flag] !== "string") throw new Error(`--${flag} needs a value`);
      params[key] = flags[flag];
    }
  }
  if (flags.every !== undefined) params.everyMinutes = workflowDuration(flags.every);
  if (flags["quiet-for"] !== undefined) params.quietMinutes = workflowDuration(flags["quiet-for"]);
  if (flags.lifetime !== undefined) params.lifetimeHours = workflowDuration(flags.lifetime) / 60;
  if (flags["max-wakeups"] !== undefined) {
    if (typeof flags["max-wakeups"] !== "string" || !/^[1-9][0-9]*$/.test(flags["max-wakeups"])) throw new Error("--max-wakeups needs a positive integer");
    params.maxWakeups = Number(flags["max-wakeups"]);
  }
  for (const [flag, key] of [["allow-push", "allowPush"], ["allow-merge", "allowMerge"], ["include-bots", "includeBots"]] as const) {
    if (flags[flag] !== undefined) params[key] = true;
  }
  if (flags.file !== undefined) {
    if (typeof flags.file !== "string" || flags.prompt !== undefined) throw new Error("Use either --file <instructions.md> or --prompt <text>");
    const file = resolve(flags.file);
    if (statSync(file).size > 64_000) throw new Error("Instructions file exceeds 64 KB");
    params.prompt = readFileSync(file, "utf8");
  }
  return params;
}
function id(value: string | undefined): string {
  if (!value || !/^[a-z0-9]+$/.test(value)) throw new Error("A task or workflow ID is required");
  return value;
}
function printWorkflow(item: Workflow): void {
  const count = item.type === "schedule-steer" ? "one shot" : `${item.wakeCount}/${item.params.maxWakeups} wake-ups`;
  console.log(`${item.id}  ${item.type}  ${item.state}  ${count}  ${item.reason}`);
}
export async function workflowCommand(args: string[], flags: Flags, api: Api): Promise<void> {
  const [command, target, type] = args;
  let result: unknown;
  if (command === "types") {
    const definitions = await api("/api/workflow-types") as WorkflowDefinition[];
    if (flags.json) console.log(JSON.stringify(definitions, null, 2));
    else for (const def of definitions) console.log(`${def.id}  ${def.name}\n  ${def.description}`);
    return;
  }
  // `start` is the verb the UI's primary button uses; `add` is kept working,
  // undocumented, so the scripts written against the first release do not break.
  if (command === "start" || command === "add") {
    if (!type) throw new Error("A workflow type is required; run workflow types");
    result = await api(`/api/tasks/${id(target)}/workflows`, "POST", { type, params: workflowFlags(flags) });
  } else if (command === "list" || command === "ls") {
    const items = await api(`/api/tasks/${id(target)}/workflows`) as Workflow[];
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else if (!items.length) console.log("No workflows attached");
    else items.forEach(printWorkflow);
    return;
  } else if (command === "show") {
    const detail = await api(`/api/workflows/${id(target)}`) as WorkflowDetail;
    if (flags.json) console.log(JSON.stringify(detail, null, 2));
    else {
      printWorkflow(detail.workflow);
      console.log(`Next check: ${detail.workflow.nextCheckAt}\nExpires: ${detail.workflow.expiresAt}\nParameters:\n${JSON.stringify(detail.workflow.params, null, 2)}`);
      for (const entry of detail.history) console.log(`${entry.at}  ${entry.kind}  ${entry.detail}`);
    }
    return;
  } else if (command === "set") {
    const detail = await api(`/api/workflows/${id(target)}`) as WorkflowDetail;
    result = await api(`/api/workflows/${id(target)}`, "PATCH", { revision: detail.workflow.revision, params: workflowFlags(flags) });
  } else if (["pause", "resume", "complete"].includes(command ?? "")) {
    result = await api(`/api/workflows/${id(target)}/${command}`, "POST", {});
  } else {
    console.log(`${wispCommand()} workflow types | start <task> <type> | list <task> | show <id> | set <id> | pause <id> | resume <id> | complete <id>
Parameters: --every 5m --prompt "..." --file instructions.md --at <ISO-8601> --pr <url>
            --on-red "..." --on-green "..." --quiet-for 30m --reviewers login,bot
            --lifetime 24h --max-wakeups 20 --allow-push --allow-merge
            --params '{"customParameter":"value"}' --json`);
    return;
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else printWorkflow(result as Workflow);
}
