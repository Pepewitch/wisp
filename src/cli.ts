import { basename, resolve } from "node:path";
import { createEventFormatter, loadAdapters, type UsageSummary } from "./adapters";
import { formatBytes, sniffImageType, type AttachmentPayload } from "./attachments";
import { sendCommand, taskMessageSummary } from "./cli-send";
import { wispCommand } from "./command";
import { loadConfig, MAX_CONFIGURED_PORT, MIN_CONFIGURED_PORT } from "./config";
import { bunSpawn, runDoctor } from "./doctor";
import { modelsReport } from "./models";
import { displayStateWord, type ApiTask, type TaskMessage, type TaskState, type Turn } from "./types";
import { BUILD_INFO, versionLine } from "./version";

const COMMAND = wispCommand();
const HELP = `Wisp — coding-agent task manager

usage:
  ${COMMAND} serve                                   run the daemon
  ${COMMAND} new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--local] [--image <path>]…
                                                       create a task (repo defaults to cwd;
                                                       model/effort fall back to config.json harnessDefaults;
                                                       --local runs in the repo itself instead of a worktree,
                                                       and archiving it never removes anything;
                                                       --image repeats, up to 10 per turn, 5 MB each)
  ${COMMAND} ls [-a]                                 list your tasks (alias: list; -a includes archived)
  ${COMMAND} show <task>                             task detail: turns, attachments, diffstat
  ${COMMAND} result <task> [turn]                    the agent's full answer for a turn (default: latest)
  ${COMMAND} log <task> [turn] [-f] [--raw]          activity feed of a turn; -f/--follow tails live
  ${COMMAND} wait <task> [--timeout <sec>]           block until done / needs-input / failed (waits through stuck);
                                               exit 0 done, 2 needs-input, 1 failed, 3 timeout
  ${COMMAND} send <task> "message" [--image <path>]…  send safely; active tasks steer or queue without stopping
  ${COMMAND} interrupt <task>                        stop the running turn (session survives)
  ${COMMAND} fresh <task>                            next turn starts a fresh harness session (the web palette's /fresh)
  ${COMMAND} push <task>                             push the task branch to origin
  ${COMMAND} archive <task> [-f|--force]             cleanup + remove worktree (refuses on unsaved work)
  ${COMMAND} project add <path> [--name <name>]      register a repo for the web project picker
  ${COMMAND} project rm <path>                       remove a configured project (task history stays)
  ${COMMAND} project ls                              list configured and historical repo paths
  ${COMMAND} project show <path>                     print a project's settings (setup/archive scripts, copy globs)
  ${COMMAND} project set <path> [--name <name>] [--setup <cmd>] [--archive <cmd>] [--copy <glob>]…
                                               [--clear-setup] [--clear-archive] [--clear-copy]
                                                    set or clear the fields the web gear dialog edits;
                                                    --copy repeats and the flags REPLACE the stored
                                                    glob list (each glob is appended at task setup)
  ${COMMAND} attach <task>                           open the harness interactively on the task's session
  ${COMMAND} token                                   print API URL + token (for the web page or other API clients)
  ${COMMAND} init [--port <port>]                    create or validate ${COMMAND === "wisp-dev" ? "~/.wisp-dev" : "~/.wisp"} without starting the daemon;
                                               --port applies only when creating a new config
  ${COMMAND} models                                  model options per harness: the effective choice for new
                                               tasks (--model > config default > harness default) and the
                                               model list the installed CLI exposes, when it exposes one
  ${COMMAND} version [--json] | --version [--json]   print the Wisp version and build commit
  ${COMMAND} doctor [--harness <name>]               activation check; optionally require one harness
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}
type Flags = Parsed["flags"];

/** Flags that take a value; everything else is boolean (so `-f`/`--force` never eat arguments). */
const VALUE_FLAGS = new Set(["harness", "model", "effort", "timeout", "name", "setup", "archive", "port"]);
/**
 * Value flags that ACCUMULATE instead of overwriting (A1b). `--image a.png
 * --image b.png` is two images, not the second one: a turn takes up to ten, and
 * silently keeping the last would drop the user's files without saying so.
 */
const REPEAT_FLAGS = new Set(["image", "copy"]);

export function parseArgs(args: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (REPEAT_FLAGS.has(key) && next !== undefined) {
        const prior = flags[key];
        flags[key] = [...(Array.isArray(prior) ? prior : []), next];
        i++;
      } else if (VALUE_FLAGS.has(key) && next !== undefined) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true; // short flags are always boolean: -f, -a, …
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * `--image ./shot.png` → the wire payload the create/send routes take (A1b).
 *
 * The daemon is still the authority: it re-sniffs the magic bytes and re-checks
 * every cap on the request. What this does is fail EARLY and locally on the two
 * things only the CLI can see — a path that does not exist, and a file that is
 * not an image — because the alternative is base64-ing 5 MB of someone's PDF up
 * a socket to be told the same thing.
 *
 * Exits rather than throwing: a bad `--image` is a usage error, and the caller
 * has not sent anything yet.
 */
async function readImageFlags(raw: string | boolean | string[] | undefined): Promise<AttachmentPayload[] | undefined> {
  if (raw === undefined) return undefined;
  if (raw === true) {
    console.error("--image requires a path (e.g. --image ./shot.png)");
    process.exit(1);
  }
  const paths = Array.isArray(raw) ? raw : [String(raw)];
  const out: AttachmentPayload[] = [];
  for (const p of paths) {
    const file = Bun.file(resolve(p));
    if (!(await file.exists())) {
      console.error(`--image ${p}: no such file`);
      process.exit(1);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!sniffImageType(bytes)) {
      console.error(`--image ${p}: not a png/jpeg/gif/webp image (magic-byte sniff)`);
      process.exit(1);
    }
    out.push({ name: basename(p), dataBase64: Buffer.from(bytes).toString("base64") });
  }
  return out;
}

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const cfg = loadConfig();
  const url = `http://${cfg.host}:${cfg.port}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error(`cannot reach wispd at ${url} — is it running? start it with: ${COMMAND} serve`);
    process.exit(1);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    console.error(`error: ${data.error ?? res.statusText}`);
    process.exit(1);
  }
  return data;
}

function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

// Keys derive from TaskState (types.ts) — adding a state without an icon is a compile error.
const STATE_ICON: Record<TaskState, string> = {
  creating: "◌",
  running: "●",
  done: "✓",
  "needs-input": "?",
  stuck: "⏸",
  failed: "✗",
};

/**
 * `wisp wait` exit codes, one per settled state. 'creating'/'running' are
 * in-flight and 'stuck' is reversible (the harness may still be alive and
 * simply quiet), so none of them end the wait — only these three do.
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
    console.log("no tasks");
    return;
  }
  for (const t of tasks) {
    const icon = STATE_ICON[t.state] ?? "·";
    // the honest word (Theme B): "exited 1" when the work landed but the
    // harness CLI exited nonzero; "failed" is reserved for no-result failures
    const word = displayStateWord(t.state, t.latest_turn_exit_code, t.latest_turn_has_result);
    const detail = t.state_detail ? `  — ${t.state_detail.slice(0, 60)}` : "";
    // the model the LATEST turn actually ran on; "(requested)" when the
    // harness never reported one — the distinction P5b exists for
    const model = t.latest_turn_model ?? (t.model ? `${t.model} (requested)` : null);
    console.log(
      `${t.id}  ${icon} ${word.padEnd(11)} ${t.harness.padEnd(7)} ${model ? `${model} ` : ""}turn ${String(t.turn_count).padEnd(2)} ${ago(t.updated_at).padEnd(4)} ${t.title.slice(0, 50)}${detail}`,
    );
  }
}

async function createCommand(positional: string[], flags: Flags): Promise<void> {
  let repo: string, prompt: string;
  if (positional.length >= 2) {
    [repo, prompt] = [positional[0]!, positional.slice(1).join(" ")];
  } else if (positional.length === 1) {
    [repo, prompt] = [process.cwd(), positional[0]!];
  } else {
    console.error(
      `usage: ${COMMAND} new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--local] [--image <path>]…`,
    );
    process.exit(1);
  }
  const harness = flags.harness;
  if (typeof harness !== "string") {
    console.error("--harness is required (e.g. --harness droid)");
    process.exit(1);
  }
  if (flags.effort !== undefined && typeof flags.effort !== "string") {
    console.error("--effort requires a value");
    process.exit(1);
  }
  const task = (await api("/api/tasks", "POST", {
    repoPath: resolve(repo),
    prompt,
    harness,
    model: typeof flags.model === "string" ? flags.model : undefined,
    effort: typeof flags.effort === "string" ? flags.effort : undefined,
    mode: flags.local ? "local" : undefined,
    attachments: await readImageFlags(flags.image),
  })) as ApiTask;
  const where = task.mode === "local" ? ", local" : "";
  console.log(`created ${task.id} (${task.harness}${task.model ? `, ${task.model}` : ""}${where}) — ${task.title}`);
}

async function resultCommand(positional: string[]): Promise<void> {
  const task = (await api(`/api/tasks/${positional[0]}`)) as ApiTask & { turns: Turn[] };
  const n = positional[1] ? Number(positional[1]) : undefined;
  const turn = n
    ? task.turns.find((candidate) => candidate.n === n)
    : [...task.turns].reverse().find((candidate) => candidate.result) ?? task.turns[task.turns.length - 1];
  if (!turn) {
    console.error("no turns yet");
    process.exit(1);
  }
  console.log(`── you (turn ${turn.n}) ──\n${turn.prompt}\n── agent ──`);
  console.log(turn.result ?? `(turn ${turn.n} is ${turn.status}, no result text)`);
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
  console.log(`${task.id}  ${word}${task.state_detail ? ` (${task.state_detail})` : ""}`);
  console.log(
    `harness: ${task.harness}${task.model ? ` (${task.model})` : ""}   session: ${task.session_id ?? "-"}`,
  );
  if (task.effort) console.log(`effort: ${task.effort}`);
  console.log(`worktree: ${task.worktree_path ?? "-"}\nbranch: ${task.branch ?? "-"}`);
  if (task.worktreeReason) console.log(task.worktreeReason);
  for (const turn of task.turns) printTurn(task, turn);
  for (const message of task.messages ?? []) {
    const summary = taskMessageSummary(message, task.archived);
    if (summary) console.log(`\n${summary}`);
  }
  if (task.diffstat) console.log(`\ndiff:\n${task.diffstat}`);
}

function printTurn(
  task: ApiTask,
  turn: Turn & { attachments: { name: string; size: number }[]; usage: UsageSummary | null },
): void {
  const model = turn.model ?? (task.model ? `${task.model} (requested)` : null);
  console.log(
    `\n— turn ${turn.n} [${turn.status}]${model ? ` · ${model}` : ""} you: ${turn.prompt.slice(0, 120).replaceAll("\n", " ")}`,
  );
  if (turn.attachments?.length) {
    const files = turn.attachments.map((attachment) => `${attachment.name} (${formatBytes(attachment.size)})`).join(", ");
    console.log(`  attached: ${files}${task.archived ? " — removed when this task was archived" : ""}`);
  }
  if (turn.usage) console.log(`  usage: ${usageLine(turn.usage)}`);
  if (turn.result) console.log(`  agent: ${turn.result.slice(0, 400)}`);
}

async function logCommand(positional: string[], flags: Flags): Promise<void> {
  const id = positional[0];
  const turnQuery = positional[1] ? `turn=${positional[1]}&` : "";
  const adapters = flags.raw ? null : loadAdapters();
  if (!flags.follow && !flags.f) {
    const data = await api(`/api/tasks/${id}/log?${turnQuery}`);
    const def = adapters?.[data.harness as string];
    const formatLine = flags.raw ? null : createEventFormatter(def);
    const pretty = formatLine
      ? (data.out as string)
          .split("\n")
          .map(formatLine)
          .filter((line): line is string => line !== null)
      : null;
    console.log(pretty ? pretty.join("\n") : data.out);
    if (data.err) console.error(data.err);
    return;
  }
  let offset = 0;
  let leftover = "";
  let formatLine: ReturnType<typeof createEventFormatter> | null = null;
  for (;;) {
    const data = await api(`/api/tasks/${id}/log?${turnQuery}offset=${offset}`);
    const def = adapters?.[data.harness as string];
    if (!flags.raw) formatLine ??= createEventFormatter(def);
    offset = data.size;
    const lines = (leftover + (data.out as string)).split("\n");
    leftover = lines.pop() ?? "";
    for (const line of lines) {
      const rendered = flags.raw ? line : formatLine!(line);
      if (rendered) console.log(rendered);
    }
    if (data.status !== "running" && data.out === "") {
      const last = flags.raw ? leftover : formatLine!(leftover);
      if (last) console.log(last);
      console.log(`— turn ${data.turn} ${data.status} —`);
      return;
    }
    if (data.out === "") await Bun.sleep(1000);
  }
}

async function waitCommand(positional: string[], flags: Flags): Promise<void> {
  const id = positional[0];
  if (!id) {
    console.error(`usage: ${COMMAND} wait <task> [--timeout <sec>]`);
    process.exit(1);
  }
  const rawTimeout = flags.timeout;
  const timeoutSec = rawTimeout === undefined ? WAIT_DEFAULT_TIMEOUT_SEC : Number(rawTimeout);
  if (typeof rawTimeout === "boolean" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    console.error(`--timeout must be a positive number of seconds (got: ${String(rawTimeout)})`);
    process.exit(1);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const task = (await api(`/api/tasks/${id}`)) as ApiTask;
    const line = `${task.id}  ${task.state}${task.state_detail ? ` — ${task.state_detail}` : ""}`;
    const code = WAIT_EXIT[task.state];
    if (code !== undefined) {
      console.log(line);
      process.exit(code);
    }
    if (Date.now() >= deadline) {
      console.log(`${line}  (timeout after ${timeoutSec}s)`);
      process.exit(3);
    }
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function projectCommand(positional: string[], flags: Flags): Promise<void> {
  const [action, path] = positional;
  if (action === "add") return addProject(path, flags);
  if (action === "rm") return removeProject(path);
  if (action === "ls") return listProjects();
  if (action === "show") return showProject(path);
  if (action === "set") return setProject(path, flags);
  console.error(`usage: ${COMMAND} project add <path> [--name <name>] | rm <path> | ls | show <path> | set <path> [flags]`);
  process.exit(1);
}

async function addProject(path: string | undefined, flags: Flags): Promise<void> {
  if (!path) {
    console.error(`usage: ${COMMAND} project add <path> [--name <name>]`);
    process.exit(1);
  }
  if (flags.name !== undefined && typeof flags.name !== "string") {
    console.error("--name requires a value");
    process.exit(1);
  }
  const project = await api("/api/projects", "POST", {
    path: resolve(path),
    name: typeof flags.name === "string" ? flags.name : undefined,
  });
  console.log(`project ${project.name ? `'${project.name}' ` : ""}added: ${project.path}`);
}

async function removeProject(path: string | undefined): Promise<void> {
  if (!path) {
    console.error(`usage: ${COMMAND} project rm <path>`);
    process.exit(1);
  }
  const project = await api("/api/projects", "DELETE", { path: resolve(path) });
  console.log(`project removed: ${project.path}`);
}

async function listProjects(): Promise<void> {
  const data = (await api("/api/repos")) as {
    repos: { path: string; name: string | null; exists: boolean }[];
  };
  if (data.repos.length === 0) {
    console.log("no projects");
    return;
  }
  for (const repo of data.repos) {
    console.log(`${repo.name ?? "-"}  ${repo.path}${repo.exists ? "" : "  (missing)"}`);
  }
}

async function showProject(path: string | undefined): Promise<void> {
  if (!path) {
    console.error(`usage: ${COMMAND} project show <path>`);
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
    }[];
  };
  const repo = data.repos.find((candidate) => candidate.path === resolved);
  if (!repo) {
    console.error(`project not found: ${resolved}`);
    process.exit(1);
  }
  console.log(`name: ${repo.name}`);
  console.log(`path: ${repo.path}`);
  console.log(`exists: ${repo.exists ? "yes" : "no (missing)"}`);
  console.log(`setup: ${repo.setupScript || "-"}`);
  console.log(`archive: ${repo.archiveScript || "-"}`);
  console.log(`copy: ${repo.copyFiles.length > 0 ? repo.copyFiles.join(", ") : "-"}`);
}

async function setProject(path: string | undefined, flags: Flags): Promise<void> {
  if (!path) {
    console.error(
      `usage: ${COMMAND} project set <path> [--name <name>] [--setup <cmd>] [--archive <cmd>] [--copy <glob>]… [--clear-setup] [--clear-archive] [--clear-copy]`,
    );
    process.exit(1);
  }
  for (const key of ["name", "setup", "archive"] as const) {
    if (flags[key] !== undefined && typeof flags[key] !== "string") {
      console.error(`--${key} requires a value`);
      process.exit(1);
    }
  }
  if (flags.copy !== undefined && !Array.isArray(flags.copy)) {
    console.error("--copy requires a value (e.g. --copy .env)");
    process.exit(1);
  }
  const body: Record<string, unknown> = { path: resolve(path) };
  if (typeof flags.name === "string") body.name = flags.name;
  for (const [flag, field, clear] of [
    ["setup", "setupScript", "clear-setup"],
    ["archive", "archiveScript", "clear-archive"],
  ] as const) {
    if (typeof flags[flag] === "string" && flags[clear] === true) {
      console.error(`--${flag} and --${clear} are mutually exclusive`);
      process.exit(1);
    }
    if (typeof flags[flag] === "string") body[field] = flags[flag];
    if (flags[clear] === true) body[field] = "";
  }
  if (Array.isArray(flags.copy) && flags["clear-copy"] === true) {
    console.error("--copy and --clear-copy are mutually exclusive");
    process.exit(1);
  }
  if (Array.isArray(flags.copy)) body.copyFiles = flags.copy;
  if (flags["clear-copy"] === true) body.copyFiles = [];
  const project = (await api("/api/projects", "POST", body)) as { name: string | null; path: string };
  console.log(`project ${project.name ? `'${project.name}' ` : ""}updated: ${project.path}`);
}

export async function cli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case "version":
    case "--version":
      console.log(flags.json ? JSON.stringify(BUILD_INFO) : versionLine());
      break;
    case "new": {
      await createCommand(positional, flags);
      break;
    }
    case "ls":
    case "list": {
      printTasks((await api(`/api/tasks${flags.all || flags.a ? "?archived=1" : ""}`)) as ListedTask[]);
      break;
    }
    case "result": {
      await resultCommand(positional);
      break;
    }
    case "show": {
      await showCommand(positional);
      break;
    }
    case "log": {
      await logCommand(positional, flags);
      break;
    }
    case "wait": {
      await waitCommand(positional, flags);
      break;
    }
    case "send": {
      await sendCommand({
        positional,
        imageFlag: flags.image,
        commandName: COMMAND,
        readImages: readImageFlags,
        request: api,
      });
      break;
    }
    case "interrupt": {
      await api(`/api/tasks/${positional[0]}/interrupt`, "POST", {});
      console.log(`interrupted — session kept; steer with: ${COMMAND} send`);
      break;
    }
    case "fresh": {
      await api(`/api/tasks/${positional[0]}/fresh-session`, "POST", {});
      console.log("fresh session armed — next turn starts cold");
      break;
    }
    case "push": {
      const data = await api(`/api/tasks/${positional[0]}/push`, "POST", {});
      console.log(data.output || "pushed");
      break;
    }
    case "archive": {
      const data = await api(`/api/tasks/${positional[0]}/archive`, "POST", {
        force: flags.force === true || flags.f === true,
      });
      console.log(`archived (branch ${data.branch} kept)`);
      // the teardown finishes in the background, so anything it decided NOT to
      // delete has to be said here — the user needs to know where their files are
      if (data.note) console.log(data.note);
      break;
    }
    case "project": {
      await projectCommand(positional, flags);
      break;
    }
    case "attach": {
      const data = await api(`/api/tasks/${positional[0]}/attach`);
      if (!data.argv) {
        console.log(data.message ?? "cannot attach");
        break;
      }
      Bun.spawnSync({
        cmd: data.argv,
        cwd: data.cwd ?? process.cwd(),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      break;
    }
    case "token": {
      const cfg = loadConfig();
      console.log(`url:   http://${cfg.host}:${cfg.port}`);
      console.log(`token: ${cfg.token}`);
      break;
    }
    case "init": {
      const rawPort = flags.port;
      if (rawPort !== undefined && typeof rawPort !== "string") {
        console.error("--port requires an integer");
        process.exit(1);
      }
      const initialPort = rawPort === undefined ? undefined : Number(rawPort);
      if (
        initialPort !== undefined &&
        (!Number.isInteger(initialPort) || initialPort < MIN_CONFIGURED_PORT || initialPort > MAX_CONFIGURED_PORT)
      ) {
        console.error(`--port must be an integer from ${MIN_CONFIGURED_PORT} to ${MAX_CONFIGURED_PORT}`);
        process.exit(1);
      }
      const cfg = loadConfig({ initialPort });
      console.log(`Wisp home ready: ${process.env.WISP_HOME ?? "~/.wisp"}`);
      console.log(`daemon URL: http://${cfg.host}:${cfg.port}`);
      if (initialPort !== undefined && cfg.port !== initialPort) {
        console.log(`existing config kept port ${cfg.port}; --port applies only to a new Wisp home`);
      }
      console.log(
        `next: register a repository with '${COMMAND} project add /path/to/repo', then run '${COMMAND} doctor'`,
      );
      break;
    }
    case "models": {
      // local-only command (like doctor): all harness knowledge sits in the
      // adapters' discovery strategies; here it's one generic call
      console.log((await modelsReport(loadAdapters(), loadConfig().harnessDefaults, bunSpawn)).join("\n"));
      break;
    }
    case "doctor": {
      if (flags.harness !== undefined && typeof flags.harness !== "string") {
        console.error("--harness requires a name (e.g. --harness droid)");
        process.exit(1);
      }
      let failed = false;
      for (const c of await runDoctor({
        selectedHarness: typeof flags.harness === "string" ? flags.harness : undefined,
      })) {
        console.log(`${c.status.padEnd(4)} ${c.name}: ${c.message}`);
        if (c.status === "fail") failed = true;
      }
      if (failed) process.exit(1);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}
