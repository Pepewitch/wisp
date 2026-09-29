import { type CommandName, offlineAnswer, respond, resolveCommand } from "./cli-help";
import { print, printError, printRaw } from "./cli-print";
import {
  api,
  daemonRequest,
  discardAttachment,
  exitApi,
  uploadAttachment,
} from "./cli-api";
import { workflowCommand } from "./cli-workflow";
import { PR_USAGE, prCommand } from "./cli-pr";
import { briefCommand } from "./cli-brief";
import { createCommand } from "./cli-create";
import { parseArgs, type Flags } from "./cli-args";
export { parseArgs } from "./cli-args";
import { retentionCommand } from "./cli-retention";
import { cleanupCommand } from "./cli-cleanup";
import { doctorCommand } from "./cli-doctor";
import { updateCommand } from "./cli-update";
import { resolve } from "node:path";
import { createEventFormatter, loadAdapters, type UsageSummary } from "./adapters";
import { formatBytes } from "./attachments";
import { readAttachmentFlags } from "./cli-attach";
import { searchCommand } from "./cli-search";
import { limitsCommand } from "./cli-limits";
import { sendCommand, taskMessageSummary } from "./cli-send";
import { exportDiagnosticLog, followHumanLog } from "./cli-stream";
import { wispCommand } from "./command";
import { loadConfig, MAX_CONFIGURED_PORT, MIN_CONFIGURED_PORT, rotateToken } from "./config";
import { bunSpawn } from "./doctor";
import { acquireHomeOwnership, HomeBusyError } from "./home-lock";
import { modelsReport } from "./models";
import { backgroundSummary, displayStateWord, STATE_ICON, type ApiTask, type TaskMessage, type TaskState, type Turn } from "./types";
import { BUILD_INFO, versionLine } from "./version";

const COMMAND = wispCommand();

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/**
 * `wisp wait` exit codes, one per settled state. 'creating'/'running' are
 * in-flight and 'stuck' is reversible (the harness may still be alive and
 * simply quiet), so none of them end the wait — only these three do.
 *
 * `needs-input` now covers two situations, and 2 is right for both: a turn
 * that ENDED asking for something, and a turn SUSPENDED inside a questionnaire
 * the harness is blocked on. The wait's promise is "block until the task is
 * finished or wants you", and a blocked harness wants you as much as a
 * finished one does. A `wisp send` after either resumes the task correctly —
 * the suspended case steers, which answers the open questionnaire on the way
 * through (see adapters/live/droid.ts).
 */
const WAIT_EXIT: Partial<Record<TaskState, number>> = { done: 0, failed: 1, "needs-input": 2 };
const WAIT_POLL_MS = 2000;
/** ~a day: long enough to be "block until it settles", finite so a wedged wait still exits 3. */
const WAIT_DEFAULT_TIMEOUT_SEC = 86_400;

/**
 * Task as the list endpoint serializes it: ApiTask plus the latest turn's
 * actual model (P5b) and the exit facts behind the "exited N" word (Theme B).
 */
type ListedTask = ApiTask & {
  latest_turn_model?: string | null;
  latest_turn_exit_code?: number | null;
  latest_turn_has_result?: boolean;
};

/**
 * A turn's usage, one compact line (Theme B): `41.2k in · 2.1k out · 24.8m
 * cached · 900 cache write · 12k reasoning`. Only the numbers the harness
 * actually reported appear — the normalized summary carries no zeros, so the
 * line invents none either.
 */
function usageLine(usage: UsageSummary): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${formatTokens(usage.outputTokens)} out`);
  if (usage.cachedInputTokens !== undefined) parts.push(`${formatTokens(usage.cachedInputTokens)} cached`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`${formatTokens(usage.cacheWriteTokens)} cache write`);
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0)
    parts.push(`${formatTokens(usage.reasoningTokens)} reasoning`);
  return parts.join(" · ");
}

/** 999 → "999", 1_500 → "1.5k", 24_800_000 → "24.8m". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function printTasks(tasks: ListedTask[]): void {
  if (tasks.length === 0) {
    print("no tasks");
    return;
  }
  for (const t of tasks) {
    const icon = STATE_ICON[t.state] ?? "·";
    // the honest word (Theme B): "exited 1" when the work landed but the
    // harness CLI exited nonzero; "failed" is reserved for no-result failures
    const word = displayStateWord(t.state, t.latest_turn_exit_code, t.latest_turn_has_result) + backgroundSummary(t);
    const detail = t.state_detail ? `  — ${t.state_detail.slice(0, 60)}` : "";
    // the model the LATEST turn actually ran on; "(requested)" when the
    // harness never reported one — the distinction P5b exists for
    const model = t.latest_turn_model ?? (t.model ? `${t.model} (requested)` : null);
    print(
      `${t.id}  ${icon} ${word.padEnd(11)} ${t.harness.padEnd(7)} ${model ? `${model} ` : ""}turn ${String(t.turn_count).padEnd(2)} ${ago(t.updated_at).padEnd(4)} ${t.title.slice(0, 50)}${detail}`,
    );
  }
}

async function resultCommand(positional: string[]): Promise<void> {
  const task = (await api(`/api/tasks/${positional[0]}`)) as ApiTask & { turns: Turn[] };
  const n = positional[1] ? Number(positional[1]) : undefined;
  const turn = n
    ? task.turns.find((candidate) => candidate.n === n)
    : [...task.turns].reverse().find((candidate) => candidate.result) ?? task.turns[task.turns.length - 1];
  if (!turn) {
    printError("no turns yet");
    process.exit(1);
  }
  print(`── you (turn ${turn.n}) ──\n${turn.prompt}\n── agent ──`);
  print(turn.result ?? `(turn ${turn.n} is ${turn.status}, no result text)`);
}

async function showCommand(positional: string[]): Promise<void> {
  const task = (await api(`/api/tasks/${positional[0]}`)) as ApiTask & {
    turns: (Turn & { attachments: { name: string; size: number }[]; usage: UsageSummary | null })[];
    messages?: (Omit<TaskMessage, "attachments_json"> & { attachments: { name: string; size: number }[] })[];
    diffstat: string | null;
    worktreeReason: string | null;
  };
  const latest = [...task.turns].sort((a, b) => b.n - a.n)[0];
  const word = displayStateWord(
    task.state,
    latest?.exit_code ?? null,
    latest !== undefined && latest.result !== null,
  );
  print(`${task.id}  ${word}${backgroundSummary(task)}${task.state_detail ? ` (${task.state_detail})` : ""}`);
  print(
    `harness: ${task.harness}${task.model ? ` (${task.model})` : ""}   session: ${task.session_id ?? "-"}`,
  );
  if (task.effort) print(`effort: ${task.effort}`);
  if (task.fast) print(`fast mode: on`);
  print(`worktree: ${task.worktree_path ?? "-"}\nbranch: ${task.branch ?? "-"}`);
  if (task.worktreeReason) print(task.worktreeReason);
  printBackground(task);
  for (const turn of task.turns) printTurn(task, turn);
  for (const message of task.messages ?? []) {
    const summary = taskMessageSummary(message, task.archived);
    if (summary) print(`\n${summary}`);
  }
  if (task.diffstat) print(`\ndiff:\n${task.diffstat}`);
}

/**
 * The tracked process groups behind the one-line status word.
 *
 * `show` is where an operator lands after reading "background work running"
 * and wanting to know whether Stop is safe, so the answer belongs here rather
 * than in a command they would have to know exists. Silent when there is
 * nothing running, which is almost always.
 */
function printBackground(task: ApiTask): void {
  const background = task.background;
  if (!background || background.state === "none") return;
  const groups = background.details.length || background.groups;
  print(`\nbackground: ${background.state} · ${groups} ${groups === 1 ? "group" : "groups"}`);
  for (const group of background.details) {
    const age = group.since ? ago(group.since) : null;
    const parts = [
      `turn ${group.turn}`,
      `pgid ${group.pgid}`,
      `${group.processes} ${group.processes === 1 ? "process" : "processes"}${group.names.length ? ` (${group.names.join(", ")})` : ""}`,
      age === null ? "the turn has not ended" : age === "now" ? "the turn just ended" : `${age} past the turn`,
    ];
    if (group.state === "unknown") parts.push("ownership unverified — Stop will refuse");
    if (group.stopRequested) parts.push("stop requested");
    print(`  ${parts.join(" · ")}`);
  }
}

function printTurn(
  task: ApiTask,
  turn: Turn & { attachments: { name: string; size: number }[]; usage: UsageSummary | null },
): void {
  const model = turn.model ?? (turn.requested_model ? `${turn.requested_model} (requested)` : null);
  print(
    `\n— turn ${turn.n} [${turn.status}]${model ? ` · ${model}` : ""} you: ${turn.prompt.slice(0, 120).replaceAll("\n", " ")}`,
  );
  if (turn.attachments?.length) {
    const files = turn.attachments.map((attachment) => `${attachment.name} (${formatBytes(attachment.size)})`).join(", ");
    print(`  attached: ${files}${task.archived && !task.attachmentsRetained ? " — removed when this task was archived" : ""}`);
  }
  if (turn.usage) print(`  usage: ${usageLine(turn.usage)}`);
  if (turn.result) print(`  agent: ${turn.result.slice(0, 400)}`);
}

async function logCommand(positional: string[], flags: Flags): Promise<void> {
  const [id, turn] = positional, turnQuery = turn ? `turn=${turn}&` : "";
  if (flags.diagnostic) return exportDiagnosticLog(id, turnQuery, Boolean(flags.follow || flags.f));
  const adapters = flags.raw ? null : loadAdapters();
  if (!flags.follow && !flags.f) {
    const data = await api(`/api/tasks/${id}/log?${turnQuery}`);
    if (data.capture_state === "evicted") { print(data.notice); return; }
    const def = adapters?.[data.harness as string];
    const formatLine = flags.raw ? null : createEventFormatter(def);
    const pretty = formatLine
      ? (data.out as string)
          .split("\n")
          .map(formatLine)
          .filter((line): line is string => line !== null)
      : null;
    if (pretty) print(pretty.join("\n"));
    else printRaw(data.out);
    if (data.err) {
      if (flags.raw) printRaw(data.err, "err");
      else printError(data.err);
    }
    return;
  }
  if (!flags.raw) {
    await followHumanLog(id, turnQuery);
    return;
  }
  // `--raw -f`: the retained harness stream as it grows
  let offset = 0;
  let leftover = "";
  for (;;) {
    const data = await api(`/api/tasks/${id}/log?${turnQuery}offset=${offset}`);
    if (data.capture_state === "evicted") { print(data.notice); return; }
    offset = data.size;
    const lines = (leftover + (data.out as string)).split("\n");
    leftover = lines.pop() ?? "";
    for (const line of lines) if (line) printRaw(line);
    if (data.status !== "running" && data.out === "") {
      if (leftover) printRaw(leftover);
      print(`— turn ${data.turn} ${data.status} —`);
      return;
    }
    if (data.out === "") await Bun.sleep(1000);
  }
}

async function waitCommand(positional: string[], flags: Flags): Promise<void> {
  const id = positional[0];
  if (!id) {
    printError(`usage: ${COMMAND} wait <task> [--timeout <sec>]`);
    process.exit(1);
  }
  const rawTimeout = flags.timeout;
  const timeoutSec = rawTimeout === undefined ? WAIT_DEFAULT_TIMEOUT_SEC : Number(rawTimeout);
  if (typeof rawTimeout === "boolean" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    printError(`--timeout must be a positive number of seconds (got: ${String(rawTimeout)})`);
    process.exit(1);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const task = (await api(`/api/tasks/${id}`)) as ApiTask;
    const line = `${task.id}  ${task.state}${task.state_detail ? ` — ${task.state_detail}` : ""}`;
    const code = WAIT_EXIT[task.state];
    if (code !== undefined) {
      print(line);
      process.exit(code);
    }
    if (Date.now() >= deadline) {
      print(`${line}  (timeout after ${timeoutSec}s)`);
      process.exit(3);
    }
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function projectCommand(positional: string[], flags: Flags): Promise<void> {
  const [action, path] = positional;
  if (action === "add") return addProject(path, flags);
  if (action === "rm") return removeProject(path);
  if (action === "ls" || action === "list") return listProjects();
  if (action === "show") return showProject(path);
  if (action === "set") return setProject(path, flags);
  printError(`usage: ${COMMAND} project add <path> [--name <name>] | rm <path> | ls|list | show <path> | set <path> [flags]`);
  process.exit(1);
}

async function addProject(path: string | undefined, flags: Flags): Promise<void> {
  if (!path) {
    printError(`usage: ${COMMAND} project add <path> [--name <name>]`);
    process.exit(1);
  }
  if (flags.name !== undefined && typeof flags.name !== "string") {
    printError("--name requires a value");
    process.exit(1);
  }
  const project = await api("/api/projects", "POST", {
    path: resolve(path),
    name: typeof flags.name === "string" ? flags.name : undefined,
  });
  print(`project ${project.name ? `'${project.name}' ` : ""}added: ${project.path}`);
}

async function removeProject(path: string | undefined): Promise<void> {
  if (!path) {
    printError(`usage: ${COMMAND} project rm <path>`);
    process.exit(1);
  }
  const project = await api("/api/projects", "DELETE", { path: resolve(path) });
  print(`project removed: ${project.path}`);
}

async function listProjects(): Promise<void> {
  const data = (await api("/api/repos")) as {
    repos: { path: string; name: string | null; exists: boolean }[];
  };
  if (data.repos.length === 0) {
    print("no projects");
    return;
  }
  for (const repo of data.repos) {
    print(`${repo.name ?? "-"}  ${repo.path}${repo.exists ? "" : "  (missing)"}`);
  }
}

async function showProject(path: string | undefined): Promise<void> {
  if (!path) {
    printError(`usage: ${COMMAND} project show <path>`);
    process.exit(1);
  }
  const resolved = resolve(path);
  const data = (await api("/api/repos")) as {
    repos: {
      path: string;
      name: string;
      exists: boolean;
      setupScript: string;
      archiveScript: string;
      copyFiles: string[];
      baseBranch: string;
    }[];
  };
  const repo = data.repos.find((candidate) => candidate.path === resolved);
  if (!repo) {
    printError(`project not found: ${resolved}`);
    process.exit(1);
  }
  print(`name: ${repo.name}`);
  print(`path: ${repo.path}`);
  print(`exists: ${repo.exists ? "yes" : "no (missing)"}`);
  print(`setup: ${repo.setupScript || "-"}`);
  print(`archive: ${repo.archiveScript || "-"}`);
  // "-" here is not "unset and broken": an empty base means Wisp resolves the
  // remote default itself, which is the right answer for almost every project
  print(`base: ${repo.baseBranch || "- (origin/HEAD)"}`);
  print(`copy: ${repo.copyFiles.length > 0 ? repo.copyFiles.join(", ") : "-"}`);
}

async function setProject(path: string | undefined, flags: Flags): Promise<void> {
  if (!path) {
    printError(
      `usage: ${COMMAND} project set <path> [--name <name>] [--setup <cmd>] [--archive <cmd>] [--base <ref>] [--copy <glob>]… ` +
        `[--clear-setup] [--clear-archive] [--clear-base] [--clear-copy]`,
    );
    process.exit(1);
  }
  for (const key of ["name", "setup", "archive", "base"] as const) {
    if (flags[key] !== undefined && typeof flags[key] !== "string") {
      printError(`--${key} requires a value`);
      process.exit(1);
    }
  }
  if (flags.copy !== undefined && !Array.isArray(flags.copy)) {
    printError("--copy requires a value (e.g. --copy .env)");
    process.exit(1);
  }
  const body: Record<string, unknown> = { path: resolve(path) };
  if (typeof flags.name === "string") body.name = flags.name;
  for (const [flag, field, clear] of [
    ["setup", "setupScript", "clear-setup"],
    ["archive", "archiveScript", "clear-archive"],
    ["base", "baseBranch", "clear-base"],
  ] as const) {
    if (typeof flags[flag] === "string" && flags[clear] === true) {
      printError(`--${flag} and --${clear} are mutually exclusive`);
      process.exit(1);
    }
    if (typeof flags[flag] === "string") body[field] = flags[flag];
    if (flags[clear] === true) body[field] = "";
  }
  if (Array.isArray(flags.copy) && flags["clear-copy"] === true) {
    printError("--copy and --clear-copy are mutually exclusive");
    process.exit(1);
  }
  if (Array.isArray(flags.copy)) body.copyFiles = flags.copy;
  if (flags["clear-copy"] === true) body.copyFiles = [];
  const project = (await api("/api/projects", "POST", body)) as { name: string | null; path: string };
  print(`project ${project.name ? `'${project.name}' ` : ""}updated: ${project.path}`);
}

function tokenCommand(flags: Flags): void {
  const rotated = flags.rotate === true;
  let cfg: ReturnType<typeof loadConfig>;
  if (rotated) {
    let ownership;
    try {
      ownership = acquireHomeOwnership();
    } catch (error) {
      if (error instanceof HomeBusyError) {
        throw new Error(
          `cannot rotate the token while the daemon is running; stop it first, rerun '${COMMAND} token --rotate', then start it again`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      cfg = rotateToken();
    } finally {
      ownership.release();
    }
  } else {
    cfg = loadConfig();
  }
  print(`url:   http://${cfg.host}:${cfg.port}`);
  print(`token: ${cfg.token}`);
  if (rotated) {
    print(`\nToken rotated in ${process.env.WISP_HOME ?? "~/.wisp"}/config.json. Start the Wisp daemon again now.`);
    print("The old token is invalid after startup.");
    print("Update every browser and saved Desktop connection with the new token.");
  }
}

function initCommand(flags: Flags): void {
  const rawPort = flags.port;
  if (rawPort !== undefined && typeof rawPort !== "string") {
    printError("--port requires an integer");
    process.exit(1);
  }
  const initialPort = rawPort === undefined ? undefined : Number(rawPort);
  if (
    initialPort !== undefined &&
    (!Number.isInteger(initialPort) || initialPort < MIN_CONFIGURED_PORT || initialPort > MAX_CONFIGURED_PORT)
  ) {
    printError(`--port must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}`);
    process.exit(1);
  }
  const cfg = loadConfig({ initialPort });
  print(`Wisp home ready: ${process.env.WISP_HOME ?? "~/.wisp"}`);
  print(`daemon URL: http://${cfg.host}:${cfg.port}`);
  if (initialPort !== undefined && cfg.port !== initialPort) {
    print(`existing config kept port ${cfg.port}; --port applies only to a new Wisp home`);
  }
  print(`next: register a repository with '${COMMAND} project add /path/to/repo', then run '${COMMAND} doctor'`);
}

async function archiveCommand(id: string | undefined, flags: Flags): Promise<void> {
  const data = await api(`/api/tasks/${id}/archive`, "POST", {
    force: flags.force === true || flags.f === true,
  });
  print(`archived (branch ${data.branch} kept); cleanup continues in the background. Check: ${COMMAND} cleanup ${id}`);
  // the teardown finishes in the background, so anything it decided NOT to
  // delete has to be said here — the user needs to know where their files are
  if (data.note) print(data.note);
}

async function attachCommand(id: string | undefined): Promise<void> {
  const data = await api(`/api/tasks/${id}/attach`);
  if (!data.argv) {
    print(data.message ?? "cannot attach");
    return;
  }
  Bun.spawnSync({
    cmd: data.argv,
    cwd: data.cwd ?? process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

type CommandHandler = (positional: string[], flags: Flags) => Promise<void> | void;

/**
 * The dispatcher: one handler per command in cli-help.ts, checked by the
 * compiler in both directions, so a command cannot exist without its usage
 * (tests/cli-help.test.ts runs `--help` on every key here). index.ts answers
 * `serve`, `version` and `doctor --storage` before this module loads, to keep
 * them free of the CLI's imports; their entries here are what they would do.
 */
export const COMMANDS = {
  serve: async () => {
    await (await import("./daemon")).serve();
  },
  new: (positional, flags) => createCommand(positional, flags),
  ls: async (_positional, flags) => {
    printTasks((await api(`/api/tasks${flags.all || flags.a ? "?archived=1" : ""}`)) as ListedTask[]);
  },
  show: (positional) => showCommand(positional),
  result: (positional) => resultCommand(positional),
  log: (positional, flags) => logCommand(positional, flags),
  search: (positional, flags) => searchCommand(positional, flags, api),
  wait: (positional, flags) => waitCommand(positional, flags),
  send: (positional, flags) =>
    sendCommand({
      positional,
      attachmentFlags: flags,
      commandName: COMMAND,
      readAttachments: (attachmentFlags) => readAttachmentFlags(attachmentFlags, uploadAttachment, discardAttachment),
      discardAttachment,
      requestError: exitApi,
      request: (path, method, body) => daemonRequest(path, method, body === undefined ? undefined : JSON.stringify(body)),
    }),
  interrupt: async (positional) => {
    await api(`/api/tasks/${positional[0]}/interrupt`, "POST", {});
    print(`interrupted — session kept; steer with: ${COMMAND} send`);
  },
  workflow: (positional, flags) => workflowCommand(positional, flags, api),
  pr: async (positional, flags) => {
    try {
      await prCommand(positional, flags, api);
    } catch (error) {
      if (error instanceof Error && error.message === PR_USAGE) { printError(PR_USAGE); process.exit(1); }
      exitApi(error);
    }
  },
  brief: (positional, flags) => briefCommand(positional, flags),
  fresh: async (positional) => {
    await api(`/api/tasks/${positional[0]}/fresh-session`, "POST", {});
    print("fresh session armed — next turn starts cold");
  },
  push: async (positional) => {
    const data = await api(`/api/tasks/${positional[0]}/push`, "POST", {});
    print(data.output || "pushed");
  },
  update: (positional) => updateCommand(positional, api),
  cleanup: (positional, flags) => cleanupCommand(positional[0], flags, api),
  archive: (positional, flags) => archiveCommand(positional[0], flags),
  export: (positional, flags) => retentionCommand("export", positional[0], flags, api),
  purge: (positional, flags) => retentionCommand("purge", positional[0], flags, api),
  project: (positional, flags) => projectCommand(positional, flags),
  attach: (positional) => attachCommand(positional[0]),
  token: (_positional, flags) => tokenCommand(flags),
  init: (_positional, flags) => initCommand(flags),
  models: async () => {
    // local-only command (like doctor): all harness knowledge sits in the
    // adapters' discovery strategies; here it's one generic call
    print((await modelsReport(loadAdapters(), loadConfig().harnessDefaults, bunSpawn)).join("\n"));
  },
  limits: (_positional, flags) => limitsCommand(flags, api),
  version: (_positional, flags) => print(flags.json ? JSON.stringify(BUILD_INFO) : versionLine()),
  doctor: (_positional, flags) => doctorCommand(flags),
} satisfies Record<CommandName, CommandHandler>;

export async function cli(args: string[]): Promise<void> {
  // help, usage and unknown commands never reach a handler (index.ts answers them first)
  const answer = offlineAnswer(args);
  if (answer) respond(answer);
  const [name = "", ...rest] = args;
  const command = resolveCommand(name)!;
  const { positional, flags } = parseArgs(rest);
  await COMMANDS[command](positional, flags);
}
