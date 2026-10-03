/**
 * Every command `wisp` dispatches, and the answers given before any of them
 * runs: `wisp help`, `<command> --help`, and an unknown command.
 *
 * PURE ON PURPOSE, like cli-brief-help.ts. index.ts answers from here before
 * anything imports config.ts, which creates the Wisp home at import time, so
 * `--help` works with no daemon, no credentials and no writable home — and can
 * never start, install, archive or print anything else. Import nothing here
 * that does I/O.
 *
 * The dispatcher in cli.ts is typed against `CommandName`, so a command cannot
 * be added without its usage, and `wisp help` is these usages joined.
 */
import { briefOfflineAnswer } from "./cli-brief-help";
import { wispCommand } from "./command";
import { controlFree } from "./control-free";

const COMMAND = wispCommand();

/** One usage block per command, in `wisp help` order. */
const COMMAND_USAGE = {
  serve: `  ${COMMAND} serve                                   run the daemon`,
  new: `  ${COMMAND} new [repo] "prompt" --harness <h> [--model <m>] [--effort <level>] [--fast] [--local] [--base <ref>] [--auto-merge] [--auto-fix] [--brief] [--attach <path>]…
                                                       create a task (repo defaults to cwd;
                                                       model/effort fall back to config.json harnessDefaults,
                                                       then Wisp's default model for the harness;
                                                       --fast runs in the harness's faster lane for the same
                                                       model, and is refused by a harness without one;
                                                       --local runs in the repo itself instead of a worktree,
                                                       and archiving it never removes anything;
                                                       --auto-merge merges the task's PR once it is ready;
                                                       --auto-fix sends red CI, a conflict, or review feedback back to the agent;
                                                       --brief asks each turn's agent for a short task brief;
                                                       --attach repeats, up to 10 files and 50 MB per turn:
                                                       images 5 MB, pdf and text 20 MB, video 50 MB
                                                       (--image is the old name and still works))`,
  ls: `  ${COMMAND} ls [-a|--all]                           list your tasks (alias: list; -a includes archived)`,
  show: `  ${COMMAND} show <task>                             task detail: turns, attachments, diffstat`,
  result: `  ${COMMAND} result <task> [turn]                    the agent's full answer for a turn (default: latest)`,
  log: `  ${COMMAND} log <task> [turn] [-f|--follow] [--raw] [--diagnostic]
                                               activity feed; --raw is the retained harness stream;
                                               --diagnostic exports retained JSONL;
                                               evicted archived transcripts are explicitly marked`,
  search: `  ${COMMAND} search <text> [-a|--all] [--json]       exact text in titles, prompts, results and queued messages
                                                    (-a includes archived tasks)`,
  wait: `  ${COMMAND} wait <task> [--timeout <sec>]           block until done / needs-input / failed (waits through stuck);
                                               exit 0 done, 2 needs-input, 1 failed, 3 timeout`,
  send: `  ${COMMAND} send <task> "message" [--attach <path>]… send safely; active tasks steer or queue without stopping`,
  interrupt: `  ${COMMAND} interrupt <task>                        stop the running turn (session survives)`,
  workflow: `  ${COMMAND} workflow <command>                      task automations: types, start, list, show, set, pause, resume, complete
                                                    (${COMMAND} workflow --help lists their parameters)`,
  pr: `  ${COMMAND} pr <task> [merge on|off | fix on|off | resume | send-now | skip | history] [--json]
                                                    auto-merge and auto-fix for the task's PR (history: what it did)`,
  audit: `  ${COMMAND} audit <task> [--limit <1-500>] [--json]  who did what to the task, newest first (default: the newest 100):
                                                    web, desktop, cli, agent:<task> (an agent running in that task),
                                                    autopilot, workflow:<id>, system, or api (an unnamed client)`,
  output: `  ${COMMAND} output add <image-path> --turn <n> [--task <task>] [--json]
                                                    publish an image in the reply (task defaults to WISP_TASK_ID)
  ${COMMAND} output list <task> --turn <n> [--json]    list image outputs and save commands
  ${COMMAND} output save <task> <image-id> --turn <n> --out <new-file>
                                                    save an output without overwriting an existing file`,
  brief: `  ${COMMAND} brief show [task] [--json]              the agent's latest task brief, its turn, and how current it is
  ${COMMAND} brief enable|disable [task]             ask each turn's agent for a short brief (off by default;
                                                    enabling starts with the next turn and never starts one)
  ${COMMAND} brief set --stdin [--replace <revision>]
                                                    what an agent runs to save its brief (${COMMAND} brief --help)`,
  fresh: `  ${COMMAND} fresh <task>                            next turn starts a fresh harness session (the web palette's /fresh)`,
  push: `  ${COMMAND} push <task>                             push the task branch to origin`,
  update: `  ${COMMAND} update [--yes]                          check for and install the latest Wisp daemon;
                                                    asks first when tasks are running (--yes: interrupt them)`,
  cleanup: `  ${COMMAND} cleanup <task> [--log|--retry|--confirm-complete|--rerun] [--verified-stopped]
                                               inspect or resolve cleanup; --verified-stopped confirms
                                               the cleanup scripts and their children have stopped`,
  archive: `  ${COMMAND} archive <task> [-f|--force]             cleanup + remove worktree (refuses on unsaved work, or while
                                               auto-merge / auto-fix watches its PR)`,
  export: `  ${COMMAND} export <task>                           print portable JSON (redirect to a private file)`,
  purge: `  ${COMMAND} purge <task> --confirm <task>          permanently delete archived Wisp data; keep Git branches
  ${COMMAND} purge --archived-before <30d|YYYY-MM-DD> [--confirm-count <n>]
                                               dry run by default; count must match to delete archives`,
  project: `  ${COMMAND} project add <path> [--name <name>]      register a repo for the web project picker
  ${COMMAND} project rm <path>                       remove a configured project (task history stays)
  ${COMMAND} project ls                              list configured and historical repo paths (alias: list)
  ${COMMAND} project show <path>                     print a project's settings (setup/archive scripts, copy globs)
  ${COMMAND} project set <path> [--name <name>] [--setup <cmd>] [--archive <cmd>] [--base <ref>] [--copy <glob>]…
                                               [--clear-setup] [--clear-archive] [--clear-base] [--clear-copy]
                                                    set or clear the fields the web gear dialog edits;
                                                    --copy repeats and the flags REPLACE the stored
                                                    glob list (each glob is appended at task setup)`,
  attach: `  ${COMMAND} attach <task>                           open the harness interactively on the task's session`,
  token: `  ${COMMAND} token [--rotate]                        print API URL + token; --rotate replaces the token
                                               (stop the daemon first, then restart it and update every client)`,
  init: `  ${COMMAND} init [--port <port>]                    create or validate ${COMMAND === "wisp-dev" ? "~/.wisp-dev" : "~/.wisp"} without starting the daemon;
                                               --port applies only when creating a new config`,
  models: `  ${COMMAND} models                                  model options per harness: the effective choice for new
                                               tasks (--model > config default > Wisp default > harness default) and the
                                               model list the installed CLI exposes, when it exposes one`,
  limits: `  ${COMMAND} limits [--refresh] [--json]             plan usage per harness (the top bar's usage popover);
                                               --refresh skips the daemon's five-minute cache`,
  version: `  ${COMMAND} version [--json] | --version [--json]   print the Wisp version and build commit`,
  doctor: `  ${COMMAND} doctor [--harness <name>]               activation check; optionally require one harness
  ${COMMAND} doctor --database                       read-only database check; no harness probes
  ${COMMAND} doctor --storage [--archived-before <30d|YYYY-MM-DD>]
                                               read-only local storage and potential reclaim; no daemon needed`,
} as const satisfies Record<string, string>;

export type CommandName = keyof typeof COMMAND_USAGE;

/** Other spellings the dispatcher accepts for a command. */
export const COMMAND_ALIASES: Readonly<Record<string, CommandName>> = { list: "ls", "--version": "version" };

/** `wisp workflow` names its verbs, so its own help lists them and their parameters. */
export function workflowUsage(): string {
  return `usage: ${COMMAND} workflow types | start <task> <type> | list <task> | show <id> | set <id> | pause <id> | resume <id> | complete <id>
Parameters: --every 5m --prompt "..." --file instructions.md --at <ISO-8601>
            --lifetime 24h --max-wakeups 20 --allow-push --allow-merge
            --params '{"customParameter":"value"}' --json`;
}

export const HELP = `Wisp — coding-agent task manager

usage:
${Object.values(COMMAND_USAGE).join("\n")}
  ${COMMAND} help [command]                          this list, or one command's usage (so does <command> --help)
`;

/** The dispatcher's name for `name`, or null when no command answers to it. */
export function resolveCommand(name: string): CommandName | null {
  if (Object.hasOwn(COMMAND_USAGE, name)) return name as CommandName;
  return Object.hasOwn(COMMAND_ALIASES, name) ? COMMAND_ALIASES[name]! : null;
}

/** What `<command> --help` prints. */
export function commandHelp(command: CommandName): string {
  return command === "workflow" ? workflowUsage() : `usage:\n${COMMAND_USAGE[command]}`;
}

export interface OfflineAnswer {
  text: string;
  exit: 0 | 1 | 2;
  stream: "out" | "err";
}

const HELP_FLAGS = new Set(["--help", "-h"]);

function unknownCommand(name: string): OfflineAnswer {
  return { text: `unknown command: ${controlFree(name)}\n\n${HELP}`, exit: 1, stream: "err" };
}

/**
 * The answer to `args` (everything after `wisp`) when it is help, usage, or no
 * command at all; null when a command should run. `--help` or `-h` anywhere
 * after a command asks for that command's usage and nothing else — the tokens
 * are never passed on, so no command can act on a line that asked for help.
 */
export function offlineAnswer(args: readonly string[]): OfflineAnswer | null {
  const [first, ...rest] = args;
  if (first === undefined || HELP_FLAGS.has(first)) return { text: HELP, exit: 0, stream: "out" };
  if (first === "help") {
    const topic = rest.find((arg) => !HELP_FLAGS.has(arg));
    if (topic === undefined || topic === "help") return { text: HELP, exit: 0, stream: "out" };
    const command = resolveCommand(topic);
    return command ? { text: commandHelp(command), exit: 0, stream: "out" } : unknownCommand(topic);
  }
  const command = resolveCommand(first);
  if (command === null) return unknownCommand(first);
  // brief keeps its own help: it is what an agent reads before saving one
  if (command === "brief") return briefOfflineAnswer(rest);
  return rest.some((arg) => HELP_FLAGS.has(arg)) ? { text: commandHelp(command), exit: 0, stream: "out" } : null;
}

/** Print an offline answer and exit with its code. */
export function respond(answer: OfflineAnswer): never {
  (answer.stream === "out" ? console.log : console.error)(answer.text.trimEnd());
  process.exit(answer.exit);
}
