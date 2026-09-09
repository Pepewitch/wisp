import { wispCommand } from "./command";
const COMMAND = wispCommand();
export const HELP = `Wisp — coding-agent task manager

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
  ${COMMAND} log <task> [turn] [-f] [--raw] [--diagnostic]  activity feed; --diagnostic exports retained JSONL
  ${COMMAND} wait <task> [--timeout <sec>]           block until done / needs-input / failed (waits through stuck);
                                               exit 0 done, 2 needs-input, 1 failed, 3 timeout
  ${COMMAND} send <task> "message" [--image <path>]…  send safely; active tasks steer or queue without stopping
  ${COMMAND} interrupt <task>                        stop the running turn (session survives)
  ${COMMAND} fresh <task>                            next turn starts a fresh harness session (the web palette's /fresh)
  ${COMMAND} push <task>                             push the task branch to origin
  ${COMMAND} update                                  check for and install the latest Wisp daemon
  ${COMMAND} cleanup <task> [--log|--retry|--confirm-complete|--rerun]  inspect or resolve cleanup
  ${COMMAND} archive <task> [-f|--force]             cleanup + remove worktree (refuses on unsaved work)
  ${COMMAND} export <task>                           print portable JSON (redirect to a private file)
  ${COMMAND} purge <task> --confirm <task>          permanently delete archived Wisp data; keep Git branches
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
  ${COMMAND} doctor --database                       read-only database check; no harness probes
`;
